const chalk = require('chalk');
const chokidar = require('chokidar');
const fs = require('fs/promises');
const glob = require('glob');
const path = require('path');
const prettier = require('prettier');
const { BehaviorSubject } = require('rxjs');
const {
  scan,
  debounceTime,
  concatMap,
  map,
  filter,
} = require('rxjs/operators');
const ts = require('typescript');
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

  const fileUpdateStream = new BehaviorSubject({ type: 'init', filePaths });

  fileUpdateStream
    .pipe(
      concatMap(async (fileEvent) => {
        try {
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
                `${timeNow()} - COMPILE - recompiled in ${
                  endTime - startTime
                }ms`
              )
            );
            return { ...fileEvent, configString };
          } else {
            return fileEvent;
          }
        } catch (error) {
          log(
            chalk.red(`Unexpected error occured while compiling...\n${error}`)
          );
          if (firstCompile) {
            process.exit(1);
          }
          return null;
        }
      }),
      filter((fileEvent) => !!fileEvent),
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
        import { DynamicDocPageConfig } from '@cdp/component-document-portal/util-types';

        export const docPageConfigs = {
          ${configStrings.toString()}
        } as Record<string, DynamicDocPageConfig>;
      `,
        { parser: 'typescript', printWidth: 100, singleQuote: true }
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
  const rawTS = (await fs.readFile('./' + filePath)).toString();

  // create a TS node source for our traversal
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    rawTS,
    ts.ScriptTarget.Latest
  );

  // Find the starting point for the recursive traversal
  // This is hopefully an object that is being default exported or has the `DocPageConfig` type
  const statementWithTitle = sourceFile.statements.find((statement) => {
    const text = statement.getText(sourceFile);

    return (
      ((text.includes('DocPageConfig') && !text.includes('import')) ||
        text.includes('export default')) &&
      text.includes('title:')
    );
  });

  if (!statementWithTitle) {
    throw new Error(`Could not find doc page config export from ${filePath}`);
  }

  // Recursively look traverse the nodes from the starting point looking for a string literal
  const rawTitle = (function recursivelyFindTitle(node) {
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (let i = 0; i < children.length; i++) {
        const result = recursivelyFindTitle(children[i]);
        if (result !== null) {
          return result;
        }
      }
    } else {
      const syntaxKind = ts.SyntaxKind[node.kind];
      if (syntaxKind === 'StringLiteral') {
        return node.getText(sourceFile);
      } else {
        return null;
      }
    }
    return null;
  })(statementWithTitle);

  if (!rawTitle) {
    throw new Error(
      `Could not find title in page config for ${filePath}...\nMake sure to only provide a single or double quote string literal.`
    );
  }

  //Getting rid of the surrounding string literal marks (single or double quotes)
  const title = rawTitle.replace(/['"]/g, '');

  // Figure out variables for config list file output
  const filePathWithoutExtension = filePath.replace('.ts', '');
  const route = title.toLowerCase().replace(/[ /]/g, '-');
  return `
      '${route}': {
        title: '${title}',
        loadConfig: () => import('../../../../${filePathWithoutExtension}').then((file) => file.default)
      }
    `;
}

function timeNow() {
  var d = new Date();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();
  const milliseconds = d.getMilliseconds();
  const h = (hours < 10 ? '0' : '') + hours;
  const m = (minutes < 10 ? '0' : '') + minutes;
  const s = (seconds < 10 ? '0' : '') + seconds;
  const ms =
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
