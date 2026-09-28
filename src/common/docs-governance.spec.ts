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

  it('points the circular-dependency advice at the comment that explains the delegation', () => {
    const section = between(read('docs/08-development-guidelines.md'), '#### Circular Dependency', '\n#### ');
    const cited = /`(src\/[^`]+\.ts)`/.exec(section)?.[1];
    expect(cited).toBeDefined();
    expect(read(cited!)).toMatch(/delegates .*one-directionally/);
  });

  // The override keeps the service's `build:` section, so `--build` would tag a source build with the
  // published image name. The README, the release guide and the migration guide give one upgrade command.
  it('gives the published-image override one upgrade command in the README, docs/14 and docs/15', () => {
    const command = 'docker compose pull openwa-api && docker compose up -d --no-build';
    const readme = between(read('README.md'), 'To run a published image', '\n## ');
    expect(readme).toContain(command);
    expect(readme).not.toMatch(/still builds from source/);
    // Compose pulls a missing image first; only a failed pull falls back to a source build.
    expect(readme).not.toMatch(/missing image would be built/);
    expect(readme).toMatch(/if the pull fails/);
    expect(between(read('docs/15-project-roadmap.md'), 'Upgrading a Compose deployment', '\n## ')).toContain(command);
    const migration = read('docs/14-migration-guide.md');
    expect(between(migration, '# 3. Move to the new version', '# 4.')).toContain(command);
    expect(between(migration, '# 5. Start the target version', 'echo')).toContain(command);
  });

  // `docker compose run` has no --no-build, so the runbook confirms the pull landed before step 7.
  it('keeps the runbook published-image upgrade from building after a failed pull', () => {
    const note = between(read('docs/11-operational-runbooks.md'), '> If you deploy the published image', '\n\n');
    expect(note).toContain('`docker compose pull openwa-api`');
    expect(note).toContain('`docker image inspect ghcr.io/rmyndharis/openwa:<tag>`');
    expect(note).toContain('`docker compose up -d --no-build`');
  });

  // Registries show the package description on its own in search results, away from the README.
  it('keeps the non-affiliation notice in every SDK registry description', () => {
    const descriptions = [
      (JSON.parse(read('sdk/javascript/package.json')) as { description: string }).description,
      (JSON.parse(read('sdk/php/composer.json')) as { description: string }).description,
      /^description = "([^"]+)"/m.exec(read('sdk/python/pyproject.toml'))?.[1],
      /<description>([^<]+)<\/description>/.exec(read('sdk/java/pom.xml'))?.[1],
    ];
    for (const description of descriptions) {
      expect(description).toMatch(
        /^Official .+ SDK for OpenWA, the open-source WhatsApp API Gateway \(not affiliated with WhatsApp or Meta\)$/,
      );
    }
  });

  // The risk guide counts this published notice as the legal risk's mitigation.
  // The project publishes no terms of service of its own, so no mitigation may rest on one.
  it('counts the README disclaimer, not user terms of service, as a risk mitigation', () => {
    const risks = read('docs/16-risk-management.md');
    expect(risks).not.toMatch(/\[[^\]]*terms of service[^\]]*\]/i);
    expect(risks).toMatch(/\[README disclaimer\]/);
  });

  it('keeps the README non-affiliation disclaimer', () => {
    const section = between(read('README.md'), '## Disclaimer', '\n## ');
    expect(section).toMatch(/not affiliated/);
    expect(section).toMatch(/WhatsApp LLC/);
  });
});
