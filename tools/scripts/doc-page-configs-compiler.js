const chalk = require('chalk');
const chokidar = require('chokidar');
const { existsSync } = require('fs');
const fs = require('fs/promises');
const glob = require('glob');
const path = require('path');
const prettier = require('prettier');
const { BehaviorSubject } = require('rxjs');
const { scan, debounceTime, concatMap, map } = require('rxjs/operators');
const ts = require('typescript');
const { v1: uniqueId } = require('uuid');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const yargOptions = yargs(hideBin(process.argv)).argv;

const docPageConfigFilesGlob = '**/*.doc-page.ts';

const shouldWatch = process.env.watch ?? yargOptions.watch ?? false;
const silenced = process.env.silent ?? yargOptions.silent ?? false;

let firstCompile = true;

(async () => {
  log(chalk.blue('Searching for component document page files...\n'));
  const startTime = Number(new Date());
  let filePaths = await new Promise((resolve) =>
    glob(docPageConfigFilesGlob, { ignore: 'node_modules' }, (_err, files) =>
      resolve(files)
    )
  );
  const endTime = Number(new Date());
  log(
    chalk.green(
      `Finished component document page file searching in ${
        endTime - startTime
      }ms`
    )
  );

  log(chalk.blue('Found the below component document page files:'));

  for (let filePath of filePaths) {
    log(chalk.yellow(filePath));
  }

  log(
    chalk.magenta(
      "\nIf your component document page isn't found, please verify the extension is `.doc-page.ts`\n"
    )
  );

  fileUpdateStream = new BehaviorSubject({ type: 'init', filePaths });

  fileUpdateStream
    .pipe(
      concatMap(async (fileEvent) => {
        if (fileEvent.type === 'init') {
          let payload = [];
          log(chalk.blue('Compiling component document page files...\n'));
          const startTime = Number(new Date());
          for (let filePath of fileEvent.filePaths) {
            const configString = await compileDynamicDocPageConfigString(
              filePath
            );
            payload.push({ filePath, configString });
          }
          const endTime = Number(new Date());
          log(
            chalk.green(
              `Finished compiling component document page files in ${
                endTime - startTime
              }ms`
            )
          );
          return { ...fileEvent, payload };
        } else if (fileEvent.type === 'add' || fileEvent.type === 'change') {
          const startTime = Number(new Date());
          const configString = await compileDynamicDocPageConfigString(
            fileEvent.filePath
          );
          const endTime = Number(new Date());
          log(
            chalk.blue(
              `${timeNow()} - COMPILE - recompiled in ${endTime - startTime}ms`
            )
          );
          return { ...fileEvent, configString };
        } else {
          return fileEvent;
        }
      }),
      scan((acc, curr) => {
        if (curr.type === 'init') {
          return curr.payload;
        } else if (curr.type === 'add') {
          return [
            ...acc,
            { filePath: curr.filePath, configString: curr.configString },
          ];
        } else if (curr.type === 'unlink') {
          return acc.filter((f) => f.filePath !== curr.filePath);
        } else if (curr.type === 'change') {
          const index = acc.findIndex((f) => f.filePath === curr.filePath);
          const copy = [...acc];
          copy[index] = {
            filePath: curr.filePath,
            configString: curr.configString,
          };
          return copy;
        }
      }, []),
      debounceTime(500),
      map((fileEvents) => fileEvents.map((fileEvent) => fileEvent.configString))
    )
    .subscribe(async (configStrings) => {
      await writeDynamicPageConfigStringsToFile(configStrings);
      if (firstCompile) {
        log(chalk.cyan('Finished creating the config list file'));
      } else {
        log(chalk.cyan(`${timeNow()} - WRITE - config list file`));
      }

      if (firstCompile && shouldWatch) {
        log(chalk.cyan('\nWatching for file changes...'));

        chokidar
          .watch(docPageConfigFilesGlob, {
            ignored: 'node_modules',
            ignoreInitial: true,
          })
          .on('all', async (event, path) => {
            const filePath = path.replaceAll('\\', '/');
            if (event === 'add' || event === 'addDir') {
              log(chalk.green(`${timeNow()} - ADDED - ${filePath}`));
              fileUpdateStream.next({ type: 'add', filePath });
            } else if (event === 'unlink' || event === 'unlinkDir') {
              log(chalk.red(`${timeNow()} - DELETED - ${filePath}`));
              fileUpdateStream.next({ type: 'unlink', filePath });
            } else {
              log(chalk.yellow(`${timeNow()} - CHANGED - ${filePath}`));
              fileUpdateStream.next({ type: 'change', filePath });
            }
          });
      }

      firstCompile = false;
    });
})();

async function writeDynamicPageConfigStringsToFile(configStrings) {
  try {
    await fs.writeFile(
      './apps/component-document-portal/src/app/doc-page-configs.ts',
      prettier.format(
        `
        import { DynamicDocPageConfig } from '@doc-page-config/types';

        export const docPageConfigs = {
          ${configStrings.toString()}
        } as Record<string, DynamicDocPageConfig>;
      `,
        { parser: 'typescript', printWidth: 100 }
      )
    );
  } catch (e) {
    console.error(e);
    log(
      chalk.red(
        `\n\nUnexpected error occurred while generating doc-page-configs.ts\n`
      )
    );
  }
}

async function compileDynamicDocPageConfigString(filePath) {
  try {
    // Transpile the TS file to raw JS (mjs)
    const rawTS = await fs.readFile('./' + filePath);
    const rawJS = ts.transpile(rawTS.toString(), { module: 'es2020' });

    // Create folder to house the temporary mjs files (easier housecleaning)
    const mjsPagesFolder = `mjs-pages`;
    const mjsPagesFolderLocation = `${__dirname}/${mjsPagesFolder}`;
    if (!existsSync(mjsPagesFolderLocation)) {
      await fs.mkdir(mjsPagesFolderLocation);
    }

    // Figure out file names & locations for mjs file
    const fileName = path.basename(filePath).replace('.ts', '');
    const mjsFileName = `${fileName}-${uniqueId()}.mjs`;
    const mjsFileLocation = `${mjsPagesFolderLocation}/${mjsFileName}`;
    const relativeMjsFileLocation = `./${mjsPagesFolder}/${mjsFileName}`;

    // write to mjs file & import the code back in to get config (delete for cleanup)
    await fs.writeFile(mjsFileLocation, rawJS);
    const file = await import(relativeMjsFileLocation);
    await fs.unlink(mjsFileLocation);

    // Figure out variables for config list file output
    const filePathWithoutExtension = filePath.replace('.ts', '');
    const docPageConfig = file.default;
    const title = docPageConfig.title;
    const route = title.toLowerCase().replace(/[ /]/g, '-');
    return `
      '${route}': {
        title: '${title}',
        getDocPage: () => import('../../../../${filePathWithoutExtension}').then((file) => file.default.docPage),
        getNgModule: () => import('../../../../${filePathWithoutExtension}').then((file) => file.default.ngModule),
      }
    `;
  } catch (e) {
    console.error(e);
    log(
      chalk.red(`\n\nUnexpected error occurred while compiling ${filePath}\n`)
    );
  }
}

function timeNow() {
  var d = new Date();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();
  const milliseconds = d.getMilliseconds();
  h = (hours < 10 ? '0' : '') + hours;
  m = (minutes < 10 ? '0' : '') + minutes;
  s = (seconds < 10 ? '0' : '') + seconds;
  ms =
    (milliseconds < 10 ? '00' : '') +
    (10 < milliseconds && milliseconds < 100 ? '0' : '') +
    milliseconds;
  return `${h}:${m}:${s}:${ms}`;
}

function log(message) {
  if (!silenced) {
    console.log(message);
  }
}