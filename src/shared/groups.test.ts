import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGroup, leads, ledBy, memberOf, normalizeGroup, withoutPosts } from './groups';
import type { TeamGroup } from './types';

const LEAD = 'r-lead0001';
const A = 'r-membera1';
const B = 'r-memberb1';
const group = (o: Partial<TeamGroup>): TeamGroup => ({ id: '', name: 'lbc', lead: LEAD, members: [A], ...o });

test('a group is a name, a lead and at least one member who is not the lead', () => {
  assert.deepEqual(normalizeGroup({ name: ' LBC Team ', lead: LEAD, members: [A, A, ' ', 3] }), { id: '', name: 'lbc-team', lead: LEAD, members: [A] });
  assert.equal(checkGroup(group({}), []), null);
  assert.deepEqual(checkGroup(group({ name: '' }), []), { field: 'name', problem: 'required' });
  assert.deepEqual(checkGroup(group({ members: [] }), []), { field: 'members', problem: 'required' });
  assert.deepEqual(checkGroup(group({ members: [A, LEAD] }), []), { field: 'members', problem: 'leadIsMember' });
  assert.deepEqual(checkGroup(group({ lead: 'whoever' }), []), { field: 'lead', problem: 'format' });
  // An ad-hoc worker by its session name.
  assert.equal(checkGroup(group({ members: ['hub-fix-api'] }), []), null);
});

test('a worker is a member of one group only, and no lead ends up under itself', () => {
  const lbc = group({ id: 'g-aaaaaaaa' });
  assert.deepEqual(checkGroup(group({ name: 'other', lead: B, members: [A] }), [lbc]), { field: 'members', problem: 'elsewhere' });
  assert.deepEqual(checkGroup(group({ name: 'lbc', lead: B, members: ['r-memberc1'] }), [lbc]), { field: 'name', problem: 'taken' });
  // The member of lbc leads its own group: a hierarchy is fine.
  assert.equal(checkGroup(group({ name: 'sub', lead: A, members: [B] }), [lbc]), null);
  // The lead of lbc put under its own member: a loop.
  assert.deepEqual(checkGroup(group({ name: 'up', lead: A, members: [LEAD] }), [lbc]), { field: 'lead', problem: 'loop' });
  // Editing a group checks it against the others, not against its old self.
  assert.equal(checkGroup({ ...lbc, members: [A, B] }, [lbc]), null);
});

test('a session belongs to a group through its post (an instance too) or its session name', () => {
  const groups = [group({ id: 'g-aaaaaaaa', members: [A, 'hub-fix-api'] })];
  const lead = { roleId: LEAD, instanceOf: null, name: 'hub-lead' };
  const member = { roleId: A, instanceOf: null, name: 'hub-a' };
  const instance = { roleId: null, instanceOf: A, name: 'hub-a-job' };
  const adhoc = { roleId: null, instanceOf: null, name: 'hub-fix-api' };
  const stranger = { roleId: B, instanceOf: null, name: 'hub-b' };
  assert.equal(memberOf(groups, member)?.name, 'lbc');
  assert.equal(memberOf(groups, instance)?.name, 'lbc');
  assert.equal(memberOf(groups, lead), null);
  assert.equal(ledBy(groups, lead).length, 1);
  assert.equal(ledBy(groups, member).length, 0);
  assert.ok(leads(groups, lead, adhoc));
  assert.ok(!leads(groups, lead, stranger));
  assert.ok(!leads(groups, member, lead));
});

test('a post that is gone leaves its groups; a group without lead or members goes', () => {
  const groups = [group({ id: 'g-aaaaaaaa', members: [A, B] }), group({ id: 'g-bbbbbbbb', name: 'x', lead: B, members: ['r-memberc1'] })];
  assert.deepEqual(withoutPosts(groups, [{ id: LEAD }, { id: A }, { id: 'r-memberc1' }]), [group({ id: 'g-aaaaaaaa', members: [A] })]);
});
