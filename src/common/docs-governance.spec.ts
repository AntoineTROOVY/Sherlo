import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

/**
 * The contributor docs restate the CI trigger branches and the repository label set by hand. Both
 * drifted: the docs and the workflows named a `develop` branch that never existed, and the label
 * table missed labels Dependabot applies to every dependency PR. These pin the hand-written copies
 * to the files that actually decide the behaviour.
 */

const root = join(__dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

type Trigger = { branches?: string[] };
type Workflow = { on?: { push?: Trigger; pull_request?: Trigger } };

describe('governance docs match the repository', () => {
  it.each(['ci.yml', 'sdk-ci.yml'])('%s runs on main only', file => {
    const wf = yaml.load(read('.github', 'workflows', file)) as Workflow;
    expect(wf.on?.push?.branches).toEqual(['main']);
    expect(wf.on?.pull_request?.branches).toEqual(['main']);
  });

  it('keeps the recommended security workflow template on main only', () => {
    const template = between(read('docs/04-security-design.md'), '# .github/workflows/security.yml', '\n```');
    expect((yaml.load(template) as Workflow).on?.push?.branches).toEqual(['main']);
  });

  it.each([
    ['docs/08-development-guidelines.md', '## 8.4', '## 8.5'],
    ['docs/10-devops-infrastructure.md', '## 10.3', '## 10.4'],
    ['docs/20-community-guidelines.md', '## 20.2', '## 20.3'],
  ])('%s names main and no develop branch', (file, from, to) => {
    const section = between(read(file), from, to);
    expect(section).toContain('`main`');
    expect(section).not.toMatch(/\bdevelop\b/);
  });

  it('documents every label the repository applies automatically', () => {
    const dependabot = yaml.load(read('.github', 'dependabot.yml')) as { updates: Array<{ labels?: string[] }> };
    const templateDir = join(root, '.github', 'ISSUE_TEMPLATE');
    const templateLabels = readdirSync(templateDir)
      .filter(name => name.endsWith('.yml'))
      .flatMap(
        name => (yaml.load(readFileSync(join(templateDir, name), 'utf8')) as { labels?: string[] }).labels ?? [],
      );
    const applied = [...new Set([...dependabot.updates.flatMap(u => u.labels ?? []), ...templateLabels])];

    const documented = new Set<string>();
    for (const line of between(read('docs/20-community-guidelines.md'), '### Issue Labels', '## 20.4').split('\n')) {
      const cells = line.split('|').map(cell => cell.trim());
      const name = cells[1]?.match(/^`([^`]+)`$/);
      if (name) documented.add(name[1]);
    }

    // Guard both parsers: either one matching nothing would make the final check pass vacuously.
    expect(applied.length).toBeGreaterThanOrEqual(6);
    expect(documented.size).toBeGreaterThanOrEqual(20);
    expect(applied.filter(label => !documented.has(label))).toEqual([]);
  });
});
