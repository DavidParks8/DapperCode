import { describeChange } from './utils';

describe('describeChange', () => {
  it.each([
    ['??', true, 'New', 'added'],
    [' M', false, 'Modified', 'modified'],
    ['M ', false, 'Modified', 'modified'],
    ['MM', false, 'Modified', 'modified'],
    ['A ', false, 'Added', 'added'],
    [' D', false, 'Deleted', 'deleted'],
    ['R ', false, 'Renamed', 'renamed'],
    ['UU', false, 'Conflict', 'conflict'],
    ['AA', false, 'Conflict', 'conflict'],
    [' T', false, 'Type changed', 'modified'],
    ['  ', false, 'Changed', 'modified'],
  ])('labels %j as %s', (code, untracked, label, tone) => {
    expect(describeChange({ code, untracked })).toEqual({ label, tone });
  });
});
