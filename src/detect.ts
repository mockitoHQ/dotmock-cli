import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type Language =
  | 'typescript'
  | 'python'
  | 'go'
  | 'ruby'
  | 'java'
  | 'curl';

const MARKERS: Array<{ file: string; lang: Language }> = [
  { file: 'package.json', lang: 'typescript' },
  { file: 'requirements.txt', lang: 'python' },
  { file: 'pyproject.toml', lang: 'python' },
  { file: 'go.mod', lang: 'go' },
  { file: 'Gemfile', lang: 'ruby' },
  { file: 'pom.xml', lang: 'java' },
  { file: 'build.gradle', lang: 'java' },
];

export function detectLanguage(cwd: string = process.cwd()): Language {
  for (const { file, lang } of MARKERS) {
    if (existsSync(join(cwd, file))) {
      return lang;
    }
  }
  return 'curl';
}
