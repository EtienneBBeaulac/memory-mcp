import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildBriefingTagPrimerSections } from '../formatters.js';
 
describe('buildBriefingTagPrimerSections', () => {
  it('keeps tag vocabularies separate per lobe', () => {
    const sections = buildBriefingTagPrimerSections([
      ['repo-a', new Map([['auth', 2]])],
      ['repo-b', new Map([['auth', 1], ['security', 3]])],
    ]);
 
    assert.equal(sections.length, 2);
    assert.ok(sections[0]?.includes('Tag Vocabulary — repo-a'));
    assert.ok(sections[0]?.includes('auth(2)'));
    assert.ok(!sections[0]?.includes('security(3)'));
    assert.ok(!sections[0]?.includes('auth(3)'));
 
    assert.ok(sections[1]?.includes('Tag Vocabulary — repo-b'));
    assert.ok(sections[1]?.includes('auth(1)'));
    assert.ok(sections[1]?.includes('security(3)'));
    assert.ok(!sections[1]?.includes('auth(3)'));
  });
 
  it('uses the generic heading when only one lobe has tags', () => {
    const sections = buildBriefingTagPrimerSections([
      ['repo-a', new Map([['auth', 2], ['security', 1]])],
      ['repo-b', new Map()],
    ]);
 
    assert.equal(sections.length, 1);
    assert.ok(sections[0]?.includes('### Tag Vocabulary (2 tags)'));
    assert.ok(!sections[0]?.includes('repo-a'));
  });
});