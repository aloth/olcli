import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AmbiguousProjectError,
  ProjectNotFoundError,
  matchProject,
  suggestProjectNames,
} from '../src/project-match.js';

const projects = [
  { id: '1', name: 'Thesis' },
  { id: '2', name: 'thesis' },
  { id: '3', name: 'Paper Draft' },
  { id: '4', name: 'Paper Final' },
  { id: '5', name: 'Grant Proposal 2026' },
  { id: '6', name: 'Masterarbeit Müller' },
];

test('exact name wins over a case-insensitive match', () => {
  assert.equal(matchProject(projects, 'Thesis').id, '1');
  assert.equal(matchProject(projects, 'thesis').id, '2');
});

test('case-insensitive exact match comes before a prefix', () => {
  assert.equal(matchProject(projects, 'PAPER DRAFT').id, '3');
  assert.equal(matchProject(projects, 'masterarbeit müller').id, '6');
});

test('a unique case-insensitive prefix resolves', () => {
  assert.equal(matchProject(projects, 'grant').id, '5');
  assert.equal(matchProject(projects, 'Paper F').id, '4');
});

test('an ambiguous prefix lists the candidates', () => {
  assert.throws(() => matchProject(projects, 'paper'), (error: unknown) => {
    assert.ok(error instanceof AmbiguousProjectError);
    assert.deepEqual(error.candidates.map((p) => p.id), ['3', '4']);
    assert.match(error.message, /"paper" matches 2 projects/);
    assert.match(error.message, /Paper Draft {2}\(3\)/);
    return true;
  });
  // Two projects whose names differ only in case, queried in a third casing.
  assert.throws(() => matchProject(projects, 'THESIS'), AmbiguousProjectError);
});

test('a miss suggests the closest names', () => {
  assert.throws(() => matchProject(projects, 'Papr Draft'), (error: unknown) => {
    assert.ok(error instanceof ProjectNotFoundError);
    assert.equal(error.suggestions[0], 'Paper Draft');
    assert.match(error.message, /Did you mean: "Paper Draft"/);
    return true;
  });
  assert.deepEqual(suggestProjectNames(projects, 'Proposal'), ['Grant Proposal 2026']);
});

test('a miss with nothing close points at olcli list', () => {
  assert.throws(() => matchProject(projects, 'zzzzzzzzzz'), /List your projects with: olcli list/);
});
