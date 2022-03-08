import { Injectable } from '@angular/core';
import { docPageConfigs } from './doc-page-configs';

@Injectable({
  providedIn: 'root',
})
export class ConfigServiceService {
  async getConfig() {
    const finalConfig = [];
    for (const [i] of Object.entries(docPageConfigs)) {
      const config = await docPageConfigs[i].loadConfig();
      finalConfig.push(config);
    }
    return finalConfig;
  }
}
