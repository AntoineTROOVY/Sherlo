import { TABLE_IMPORTERS } from './table-importers';

/**
 * The sessions importer is the one restore path that writes a value later used to build an on-disk
 * auth-directory path, and it bypasses CreateSessionDto. Both columns matter: the id keys the
 * directory, the name is matched against the legacy one. A row carrying a traversal in either must
 * be skipped with a reason rather than inserted.
 */
describe('sessions table importer', () => {
  const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
  const row = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    id: '0a941dac-a965-45e7-b318-74ae8be134f0',
    name: 'my-bot',
    status: 'created',
    ...overrides,
  });

  it('accepts a row whose id and name are both safe path keys', () => {
    expect(sessions?.skip?.(row({}) as never)).toBeNull();
  });

  it('skips a row whose id would traverse out of the auth directory', () => {
    expect(sessions?.skip?.(row({ id: '../../etc' }) as never)).toMatch(/unsafe id/);
  });

  it('skips a row whose name would traverse out of the auth directory', () => {
    expect(sessions?.skip?.(row({ name: '../alice' }) as never)).toMatch(/unsafe name/);
  });
});

describe('sessions table importer: desiredState', () => {
  const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
  const base = { id: '0a941dac-a965-45e7-b318-74ae8be134f0', name: 'my-bot', status: 'disconnected' };
  const mapped = (extra: Record<string, unknown>): unknown[] => sessions!.map({ ...base, ...extra } as never);

  it('writes desiredState so a stopped session stays down after a restore', () => {
    expect(sessions?.sql).toContain('"desiredState"');
    expect(sessions?.sql).toContain('$13');
    expect(mapped({ desiredState: 'stopped' })[12]).toBe('stopped');
  });

  it('restores a row without the field, or with an unknown value, as eligible (NULL)', () => {
    expect(mapped({})[12]).toBeNull();
    expect(mapped({ desiredState: 'bogus' })[12]).toBeNull();
  });
});

/**
 * A restore bypasses CreateWebhookDto. Dispatch reads a filters object without a conditions array as
 * "no filtering", so a malformed one stored verbatim would deliver every subscribed event; a non-list
 * events column silently never fires. Both are vetoed with a reason instead.
 */
describe('webhooks table importer', () => {
  const webhooks = TABLE_IMPORTERS.find(importer => importer.key === 'webhooks');
  const skip = (overrides: Record<string, unknown>) =>
    webhooks?.skip?.({ id: 'wh-1', events: ['message.received'], filters: null, ...overrides } as never);
  const chatFilter = { conditions: [{ field: 'isGroup', operator: 'is', value: true }] };

  it('accepts events and filters in either decoded or JSON-text form', () => {
    expect(skip({})).toBeNull();
    expect(skip({ events: '["message.received","*"]', filters: JSON.stringify(chatFilter) })).toBeNull();
    expect(skip({ filters: chatFilter })).toBeNull();
    expect(skip({ events: undefined, filters: undefined })).toBeNull();
  });

  it.each([['message.received'], ['not json'], [{ 0: 'message.received' }], [[1]], ['[null]']])(
    'skips a row whose events is %j',
    events => {
      expect(skip({ events })).toMatch(/events/);
    },
  );

  it.each([[{}], [{ conditions: 'x' }], ['not json'], ['{}'], [{ conditions: [{ field: 'nope', operator: 'is' }] }]])(
    'skips a row whose filters is %j',
    filters => {
      expect(skip({ filters })).toMatch(/filters/);
    },
  );
});

/**
 * A restore bypasses the automation rule DTOs. A conditions value without a conditions array matches
 * every inbound message, so a malformed one stored verbatim would autoreply to every contact.
 */
describe('automationRules table importer', () => {
  const automationRules = TABLE_IMPORTERS.find(importer => importer.key === 'automationRules');
  const skip = (overrides: Record<string, unknown>) =>
    automationRules?.skip?.({ id: 'rule-1', conditions: null, ...overrides } as never);
  const chatCondition = { conditions: [{ field: 'isGroup', operator: 'is', value: false }] };

  it('accepts no conditions, or conditions in either decoded or JSON-text form', () => {
    expect(skip({})).toBeNull();
    expect(skip({ conditions: undefined })).toBeNull();
    expect(skip({ conditions: chatCondition })).toBeNull();
    expect(skip({ conditions: JSON.stringify(chatCondition) })).toBeNull();
  });

  it.each([
    [{ condition: [] }],
    [{ conditions: 'x' }],
    [{ conditions: [null] }],
    ['not json'],
    [{ conditions: [{ field: 'nope', operator: 'is' }] }],
  ])('skips a row whose conditions is %j', conditions => {
    expect(skip({ conditions })).toMatch(/Skipped automation rule rule-1: invalid conditions/);
  });
});
