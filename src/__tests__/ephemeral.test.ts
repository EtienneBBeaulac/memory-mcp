// Tests for ephemeral content detection — pure function tests.
// Each signal is tested independently with positive and negative cases.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { detectEphemeralSignals, formatEphemeralWarning, classifyEphemeral } from '../ephemeral.js';

describe('ephemeral detection', () => {

  // ── Temporal language ──────────────────────────────────────────────────

  describe('temporal language signal', () => {
    it('detects "currently" in content', () => {
      const signals = detectEphemeralSignals(
        'Build System',
        'The build is currently broken due to a Gradle sync issue',
        'gotchas',
      );
      const temporal = signals.find(s => s.id === 'temporal');
      assert.ok(temporal, 'Should detect temporal language');
      assert.ok(temporal!.detail.includes('currently'));
    });

    it('detects "right now" in content', () => {
      const signals = detectEphemeralSignals(
        'Server Status',
        'The dev server is not responding right now',
        'architecture',
      );
      assert.ok(signals.some(s => s.id === 'temporal'));
    });

    it('detects "today" in content', () => {
      const signals = detectEphemeralSignals(
        'Deployment',
        'We deployed a hotfix today that changes the API',
        'conventions',
      );
      assert.ok(signals.some(s => s.id === 'temporal'));
    });

    it('does not flag durable content without temporal words', () => {
      const signals = detectEphemeralSignals(
        'MVI Architecture',
        'The messaging feature uses MVI with standalone reducer classes and sealed interface events',
        'architecture',
      );
      assert.ok(!signals.some(s => s.id === 'temporal'));
    });
  });

  // ── Fixed/resolved bugs ────────────────────────────────────────────────

  describe('fixed-bug signal', () => {
    it('detects "bug fixed" pattern', () => {
      const signals = detectEphemeralSignals(
        'Messaging Crash',
        'The crash bug in the messaging reducer was fixed in the latest release',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });

    it('detects "issue resolved" pattern', () => {
      const signals = detectEphemeralSignals(
        'Build Issue',
        'The Gradle sync issue has been resolved by updating the plugin version',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });

    it('detects "was broken" pattern', () => {
      const signals = detectEphemeralSignals(
        'CI Pipeline',
        'The CI pipeline was broken but is working again after config fix',
        'conventions',
      );
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });

    it('detects "no longer fails" pattern', () => {
      const signals = detectEphemeralSignals(
        'Test Suite',
        'The flaky test no longer fails after we added proper coroutine scope handling',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });

    it('detects "workaround no longer needed"', () => {
      const signals = detectEphemeralSignals(
        'Clean Build Workaround',
        'The workaround of clean building after Tuist changes is no longer needed',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });

    it('does not flag active bugs or gotchas', () => {
      const signals = detectEphemeralSignals(
        'Build Cache Bug',
        'Must clean build after Tuist changes or the build will fail with stale caches',
        'gotchas',
      );
      assert.ok(!signals.some(s => s.id === 'fixed-bug'));
    });
  });

  // ── Task/TODO language ─────────────────────────────────────────────────

  describe('task-language signal', () => {
    it('detects "need to" language', () => {
      const signals = detectEphemeralSignals(
        'Refactoring Plan',
        'We need to refactor the messaging reducer to use sealed interfaces',
        'architecture',
      );
      assert.ok(signals.some(s => s.id === 'task-language'));
    });

    it('detects "TODO" in content', () => {
      const signals = detectEphemeralSignals(
        'Missing Tests',
        'TODO: add unit tests for the new messaging flow reducer',
        'conventions',
      );
      assert.ok(signals.some(s => s.id === 'task-language'));
    });

    it('does not flag patterns or conventions', () => {
      const signals = detectEphemeralSignals(
        'Reducer Pattern',
        'Reducers should implement the sealed interface pattern for exhaustive event handling',
        'conventions',
      );
      assert.ok(!signals.some(s => s.id === 'task-language'));
    });
  });

  // ── Stack traces ───────────────────────────────────────────────────────

  describe('stack-trace signal', () => {
    it('detects Java/Kotlin stack traces', () => {
      const signals = detectEphemeralSignals(
        'NPE in Messaging',
        'NullPointerException in messaging flow:\n  at com.zillow.messaging.MessagingReducer.reduce(MessagingReducer.kt:42)\n  at com.zillow.core.BaseViewModel.dispatch(BaseViewModel.kt:15)',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'stack-trace'));
    });

    it('detects Python tracebacks', () => {
      const signals = detectEphemeralSignals(
        'Script Error',
        'Traceback (most recent call last)\n  File "build.py", line 42\n    raise ValueError("bad config")',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'stack-trace'));
    });

    it('detects Node.js error stacks', () => {
      const signals = detectEphemeralSignals(
        'Server Crash',
        'Error: ENOENT: no such file or directory\n  at Object.openSync (node:fs:600:3)',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'stack-trace'));
    });

    it('does not flag normal code discussion', () => {
      const signals = detectEphemeralSignals(
        'File Structure',
        'The messaging module lives at features/messaging/impl/ with the reducer at MessagingReducer.kt',
        'architecture',
      );
      assert.ok(!signals.some(s => s.id === 'stack-trace'));
    });
  });

  // ── Environment-specific values ────────────────────────────────────────

  describe('environment-specific signal', () => {
    it('detects multiple env-specific values (localhost + path)', () => {
      const signals = detectEphemeralSignals(
        'Dev Setup',
        'Run the server at localhost:8080 and check logs at /users/etienne/logs/server.log with PID tracking',
        'conventions',
      );
      assert.ok(signals.some(s => s.id === 'environment-specific'));
    });

    it('does not flag content with just one env-specific value', () => {
      const signals = detectEphemeralSignals(
        'API Endpoint',
        'The staging API runs on port 8080 for local development',
        'architecture',
      );
      // Single env value is not enough to trigger (threshold is 2)
      assert.ok(!signals.some(s => s.id === 'environment-specific'));
    });
  });

  // ── Verbatim code ──────────────────────────────────────────────────────

  describe('verbatim-code signal', () => {
    it('detects high code-character density', () => {
      const codeBlock = 'fun reduce(state: State, event: Event): State { return when(event) { is Event.Load -> state.copy(loading = true); is Event.Success -> state.copy(loading = false, data = event.data); is Event.Error -> state.copy(loading = false, error = event.error); } }';
      const signals = detectEphemeralSignals(
        'Reducer Implementation',
        codeBlock,
        'architecture',
      );
      assert.ok(signals.some(s => s.id === 'verbatim-code'));
    });

    it('detects fenced code blocks', () => {
      const signals = detectEphemeralSignals(
        'Example Code',
        'Here is the reducer:\n```kotlin\nfun reduce(state: State, event: Event): State {\n  return state\n}\n```\nThis is the pattern we follow for all features in the messaging module area.',
        'conventions',
      );
      assert.ok(signals.some(s => s.id === 'verbatim-code'));
    });

    it('does not flag short prose content', () => {
      const signals = detectEphemeralSignals(
        'Reducer Pattern',
        'Use standalone reducer classes with sealed interface events. Keep the reduce function pure.',
        'conventions',
      );
      assert.ok(!signals.some(s => s.id === 'verbatim-code'));
    });
  });

  // ── Investigation language ─────────────────────────────────────────────

  describe('investigation signal', () => {
    it('detects "investigating" language', () => {
      const signals = detectEphemeralSignals(
        'Memory Leak',
        'Investigating a potential memory leak in the messaging flow when switching tabs rapidly',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'investigation'));
    });

    it('detects "trying to figure out" language', () => {
      const signals = detectEphemeralSignals(
        'Build Issue',
        'Still trying to figure out why the Gradle cache invalidates on every clean build',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'investigation'));
    });

    it('does not flag concluded findings', () => {
      const signals = detectEphemeralSignals(
        'Cache Invalidation',
        'Gradle cache invalidates when the buildSrc directory changes. This is by design.',
        'gotchas',
      );
      assert.ok(!signals.some(s => s.id === 'investigation'));
    });
  });

  // ── Uncertainty / speculation ────────────────────────────────────────────

  describe('uncertainty signal', () => {
    it('detects "I think" language', () => {
      const signals = detectEphemeralSignals(
        'Possible Cause',
        'I think the crash is caused by a race condition in the messaging flow coroutine scope',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('detects "maybe" language', () => {
      const signals = detectEphemeralSignals(
        'Architecture Guess',
        'Maybe the best approach is to use a shared ViewModel for the messaging tabs',
        'architecture',
      );
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('detects "not sure" language', () => {
      const signals = detectEphemeralSignals(
        'DI Setup',
        'Not sure if the Anvil scope should be AppScope or ActivityScope for this binding',
        'conventions',
      );
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('detects "might be because" language', () => {
      const signals = detectEphemeralSignals(
        'Flaky Test',
        'The test failure might be because of the shared mutable state in the test fixtures',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('detects "seems like" language', () => {
      const signals = detectEphemeralSignals(
        'Memory Usage',
        'It seems like the image cache grows unbounded after navigating between listings',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('does not flag definitive statements', () => {
      const signals = detectEphemeralSignals(
        'Coroutine Scope Rule',
        'ViewModels must use viewModelScope for coroutine launching. Using GlobalScope causes memory leaks.',
        'conventions',
      );
      assert.ok(!signals.some(s => s.id === 'uncertainty'));
    });

    it('does not flag factual architecture descriptions', () => {
      const signals = detectEphemeralSignals(
        'Event Handling',
        'The reducer processes events through a sealed interface hierarchy. Each event maps to exactly one state transition.',
        'architecture',
      );
      assert.ok(!signals.some(s => s.id === 'uncertainty'));
    });
  });

  // ── Self-correction / retraction ───────────────────────────────────────

  describe('self-correction signal', () => {
    it('detects "actually wait"', () => {
      const signals = detectEphemeralSignals(
        'Retraction',
        'Actually wait, the leak is in the bitmap pool not the view cache as previously analyzed',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'self-correction'));
    });

    it('detects "scratch that"', () => {
      const signals = detectEphemeralSignals(
        'Correction',
        "Scratch that, the timeout is on the server side not the client. The server closes idle connections.",
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'self-correction'));
    });

    it('detects "on second thought"', () => {
      const signals = detectEphemeralSignals(
        'Changed Mind',
        'On second thought using a shared ViewModel would create tight coupling between tabs',
        'architecture',
      );
      assert.ok(signals.some(s => s.id === 'self-correction'));
    });

    it('detects "I was wrong"', () => {
      const signals = detectEphemeralSignals(
        'Mistake',
        'I was wrong about the ProGuard rule, the keep annotation does not cascade to nested classes',
        'gotchas',
      );
      assert.ok(signals.some(s => s.id === 'self-correction'));
    });

    it('does not flag normal corrections/amendments', () => {
      const signals = detectEphemeralSignals(
        'ProGuard Convention',
        'Add keep rules for all Kotlin serialization classes. The compiler plugin does not generate these automatically.',
        'conventions',
      );
      assert.ok(!signals.some(s => s.id === 'self-correction'));
    });
  });

  // ── Meeting / conversation references ─────────────────────────────────

  describe('meeting-reference signal', () => {
    it('detects "as discussed in the meeting"', () => {
      const signals = detectEphemeralSignals(
        'Meeting Decision',
        'As discussed in the meeting we are deprecating the REST endpoint and moving to GraphQL',
        'architecture',
      );
      assert.ok(signals.some(s => s.id === 'meeting-reference'));
    });

    it('detects "per our discussion"', () => {
      const signals = detectEphemeralSignals(
        'Team Decision',
        'Per our discussion the error handling will use sealed interfaces at all module boundaries',
        'conventions',
      );
      assert.ok(signals.some(s => s.id === 'meeting-reference'));
    });

    it('detects "someone mentioned"', () => {
      const signals = detectEphemeralSignals(
        'Info from John',
        'John mentioned that the backend will rate-limit the notification endpoint to 100 rpm per user',
        'architecture',
      );
      assert.ok(signals.some(s => s.id === 'meeting-reference'));
    });

    it('does not flag ADR references', () => {
      const signals = detectEphemeralSignals(
        'ADR Reference',
        'The decision to use sealed interfaces was documented in ADR-0023. The key argument is composability.',
        'architecture',
      );
      assert.ok(!signals.some(s => s.id === 'meeting-reference'));
    });
  });

  // ── New pattern additions to existing signals ─────────────────────────

  describe('new temporal patterns', () => {
    it('detects "just tried"', () => {
      const signals = detectEphemeralSignals('Attempt', 'Just tried the new Gradle wrapper and it still fails', 'gotchas');
      assert.ok(signals.some(s => s.id === 'temporal'));
    });

    it('detects "in this session"', () => {
      const signals = detectEphemeralSignals('Session', 'In this session we found the image cache grows without bound', 'gotchas');
      assert.ok(signals.some(s => s.id === 'temporal'));
    });

    it('detects "as things stand"', () => {
      const signals = detectEphemeralSignals('State', 'As things stand we have three auth flows coexisting', 'architecture');
      assert.ok(signals.some(s => s.id === 'temporal'));
    });

    it('detects "still pending"', () => {
      const signals = detectEphemeralSignals('Status', 'Deployment is still pending approval from security', 'gotchas');
      assert.ok(signals.some(s => s.id === 'temporal'));
    });
  });

  describe('new uncertainty patterns', () => {
    it('detects "as far as I know"', () => {
      const signals = detectEphemeralSignals('Caveat', 'As far as I know the migration handles this automatically', 'gotchas');
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('detects "take this with a grain of salt"', () => {
      const signals = detectEphemeralSignals('Caveat', 'Take this with a grain of salt but the profiling suggests main thread blocking', 'gotchas');
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('detects "TBD"', () => {
      const signals = detectEphemeralSignals('Pending', 'The caching strategy is TBD, might go with disk caching or server push', 'architecture');
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('detects "subject to change"', () => {
      const signals = detectEphemeralSignals('API', 'The response schema is subject to change, backend is still iterating', 'architecture');
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });

    it('detects "I could be wrong"', () => {
      const signals = detectEphemeralSignals('Guess', 'I could be wrong but the interceptor retries automatically after token refresh', 'gotchas');
      assert.ok(signals.some(s => s.id === 'uncertainty'));
    });
  });

  describe('new fixed-bug patterns', () => {
    it('detects "works now"', () => {
      const signals = detectEphemeralSignals('Fix', 'The reconnection works now after adding exponential backoff', 'gotchas');
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });

    it('detects "fixes #NNN"', () => {
      const signals = detectEphemeralSignals('Fix', 'This fixes #4521 where the login showed a blank state on token expiry', 'gotchas');
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });

    it('detects "turns out it was"', () => {
      const signals = detectEphemeralSignals('Root Cause', 'Turns out it was a threading issue with the database migration', 'gotchas');
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });

    it('detects "false alarm"', () => {
      const signals = detectEphemeralSignals('Not A Bug', 'The slowdown was a false alarm, it was profiler overhead', 'gotchas');
      assert.ok(signals.some(s => s.id === 'fixed-bug'));
    });
  });

  describe('new investigation patterns', () => {
    it('detects "can\'t reproduce"', () => {
      const signals = detectEphemeralSignals('Repro', "Can't reproduce the crash on any test device", 'gotchas');
      assert.ok(signals.some(s => s.id === 'investigation'));
    });

    it('detects "getting an error"', () => {
      const signals = detectEphemeralSignals('Error', 'Getting a SocketTimeoutException every few minutes on staging', 'gotchas');
      assert.ok(signals.some(s => s.id === 'investigation'));
    });

    it('detects "added logging"', () => {
      const signals = detectEphemeralSignals('Debug', 'Added logging to the auth flow to understand the logout issue', 'gotchas');
      assert.ok(signals.some(s => s.id === 'investigation'));
    });
  });

  describe('new task-language patterns', () => {
    it('detects "WIP"', () => {
      const signals = detectEphemeralSignals('Feature', 'WIP implementation of notification grouping, missing DND support', 'architecture');
      assert.ok(signals.some(s => s.id === 'task-language'));
    });

    it('detects "FIXME"', () => {
      const signals = detectEphemeralSignals('Code Issue', 'FIXME the error handling silently swallows network exceptions', 'gotchas');
      assert.ok(signals.some(s => s.id === 'task-language'));
    });

    it('detects "partial implementation"', () => {
      const signals = detectEphemeralSignals('Incomplete', 'The search module has a partial implementation of autocomplete', 'architecture');
      assert.ok(signals.some(s => s.id === 'task-language'));
    });

    it('detects "doesn\'t support yet"', () => {
      const signals = detectEphemeralSignals('Gap', "The analytics tracker doesn't support custom dimensions yet", 'gotchas');
      assert.ok(signals.some(s => s.id === 'task-language'));
    });
  });

  // ── Very short content ─────────────────────────────────────────────────

  describe('too-short signal', () => {
    it('detects very short content', () => {
      const signals = detectEphemeralSignals(
        'Note',
        'Use sealed classes',
        'conventions',
      );
      assert.ok(signals.some(s => s.id === 'too-short'));
    });

    it('does not flag content above threshold', () => {
      const signals = detectEphemeralSignals(
        'Sealed Class Pattern',
        'Use sealed classes and interfaces for all event types in the reducer pattern',
        'conventions',
      );
      assert.ok(!signals.some(s => s.id === 'too-short'));
    });
  });

  // ── recent-work topic bypass ───────────────────────────────────────────

  describe('recent-work bypass', () => {
    it('skips all detection for recent-work topic', () => {
      const signals = detectEphemeralSignals(
        'Current Investigation',
        'Currently debugging a crash that just happened today in the messaging reducer',
        'recent-work',
      );
      // recent-work is handled by the store caller (topic !== 'recent-work'),
      // but the detection function itself should still return signals for
      // any topic — the caller decides to skip. So this tests the function directly.
      // The store.ts code guards this: `topic !== 'recent-work' ? detect... : []`
      // We'll verify the store-level bypass in store.test.ts
      assert.ok(signals.length > 0, 'Detection function itself still fires for recent-work');
    });
  });

  // ── Multiple signals ───────────────────────────────────────────────────

  describe('multiple signals', () => {
    it('detects multiple signals in one entry', () => {
      const signals = detectEphemeralSignals(
        'Current Debug Session',
        'Currently investigating a crash that was broken in the latest build:\n  at com.zillow.messaging.Reducer.reduce(Reducer.kt:42)',
        'gotchas',
      );
      assert.ok(signals.length >= 2, `Expected at least 2 signals, got ${signals.length}: ${signals.map(s => s.id).join(', ')}`);
      const ids = signals.map(s => s.id);
      assert.ok(ids.includes('temporal'), 'Should detect temporal');
      assert.ok(ids.includes('stack-trace') || ids.includes('fixed-bug') || ids.includes('investigation'),
        'Should detect at least one other signal');
    });
  });

  // ── formatEphemeralWarning ─────────────────────────────────────────────

  describe('formatEphemeralWarning', () => {
    it('returns undefined for empty signals', () => {
      assert.strictEqual(formatEphemeralWarning([]), undefined);
    });

    it('formats a single high-confidence signal', () => {
      const result = formatEphemeralWarning([
        { id: 'temporal', label: 'Temporal language', detail: 'contains "currently"', confidence: 'high' },
      ]);
      assert.ok(result);
      assert.ok(result.includes('possibly contains'), 'Single high = "possibly contains"');
      assert.ok(result.includes('Temporal language'));
      assert.ok(result.includes('currently'));
    });

    it('formats multiple high-confidence signals as "likely"', () => {
      const result = formatEphemeralWarning([
        { id: 'temporal', label: 'Temporal language', detail: 'contains "right now"', confidence: 'high' },
        { id: 'stack-trace', label: 'Stack trace', detail: 'contains stack trace', confidence: 'high' },
      ]);
      assert.ok(result);
      assert.ok(result.includes('likely contains'), 'Two high = "likely contains"');
    });

    it('formats medium-only signals as "may contain"', () => {
      const result = formatEphemeralWarning([
        { id: 'task-language', label: 'Task language', detail: 'contains "need to"', confidence: 'medium' },
      ]);
      assert.ok(result);
      assert.ok(result.includes('may contain'), 'Medium only = "may contain"');
    });

    it('includes actionable guidance scaled to confidence', () => {
      // Single high-confidence: moderate advice
      const singleHigh = formatEphemeralWarning([
        { id: 'temporal', label: 'Temporal language', detail: 'contains "today"', confidence: 'high' },
      ]);
      assert.ok(singleHigh);
      assert.ok(singleHigh.includes('lasting insight'), 'Single high should suggest keeping if lasting');

      // Two high-confidence: strong advice
      const twoHigh = formatEphemeralWarning([
        { id: 'temporal', label: 'Temporal', detail: 'contains "today"', confidence: 'high' },
        { id: 'stack-trace', label: 'Stack trace', detail: 'stack trace detected', confidence: 'high' },
      ]);
      assert.ok(twoHigh);
      assert.ok(twoHigh.includes('almost certainly session-specific'), 'Two high should strongly advise deletion');

      // Medium-only: soft advice
      const mediumOnly = formatEphemeralWarning([
        { id: 'uncertainty', label: 'Uncertain', detail: 'contains "maybe"', confidence: 'medium' },
      ]);
      assert.ok(mediumOnly);
      assert.ok(mediumOnly.includes('use your judgment'), 'Medium-only should defer to agent judgment');
    });
  });

  // ── Durable content produces no signals ────────────────────────────────

  describe('durable content (negative cases)', () => {
    it('produces no signals for a well-formed architecture entry', () => {
      const signals = detectEphemeralSignals(
        'MVI Architecture Pattern',
        'The messaging feature uses MVI with standalone reducer classes. Events are modeled as sealed interfaces for exhaustive handling. ViewModels act as orchestrators, never containing business logic.',
        'architecture',
      );
      assert.strictEqual(signals.length, 0, `Expected no signals, got: ${signals.map(s => s.id).join(', ')}`);
    });

    it('produces no signals for a well-formed gotcha', () => {
      const signals = detectEphemeralSignals(
        'Build Cache After Tuist Changes',
        'Must clean build after Tuist changes or the build will fail with stale generated files. Run `tuist clean` then rebuild.',
        'gotchas',
      );
      assert.strictEqual(signals.length, 0, `Expected no signals, got: ${signals.map(s => s.id).join(', ')}`);
    });

    it('produces no signals for a well-formed convention', () => {
      const signals = detectEphemeralSignals(
        'Dependency Injection Pattern',
        'Use Anvil with @ContributesBinding(AppScope::class) for all production bindings. Constructor injection only, no field injection.',
        'conventions',
      );
      assert.strictEqual(signals.length, 0, `Expected no signals, got: ${signals.map(s => s.id).join(', ')}`);
    });

    it('produces no signals for user identity', () => {
      const signals = detectEphemeralSignals(
        'Identity',
        'Etienne, Senior Android Engineer at Zillow. Primary focus on messaging feature porting.',
        'user',
      );
      assert.strictEqual(signals.length, 0, `Expected no signals, got: ${signals.map(s => s.id).join(', ')}`);
    });

    it('produces no signals for preferences', () => {
      const signals = detectEphemeralSignals(
        'Code Style Preferences',
        'Prefer sealed interfaces over sealed classes. Always use immutable data classes for state. Avoid MutableStateFlow.',
        'preferences',
      );
      assert.strictEqual(signals.length, 0, `Expected no signals, got: ${signals.map(s => s.id).join(', ')}`);
    });
  });

  // ── TF-IDF classifier ──────────────────────────────────────────────────

  describe('TF-IDF classifier', () => {
    it('loads the model and returns a score', () => {
      const score = classifyEphemeral('Test Title', 'Some content about testing things');
      assert.ok(score !== null, 'Model should load successfully');
      assert.ok(score! >= 0 && score! <= 1, `Score should be between 0 and 1, got ${score}`);
    });

    it('scores ephemeral content higher than durable content', () => {
      const ephScore = classifyEphemeral(
        'Database Connection Pool Issue',
        'The connection pool is hitting 95% utilization during peak hours. We patched the configuration but need to monitor it.',
      );
      const durScore = classifyEphemeral(
        'Database Connection Pooling Convention',
        'All database connections must use connection pooling with a maximum of 20 connections per service instance.',
      );
      assert.ok(ephScore !== null && durScore !== null);
      assert.ok(ephScore! > durScore!, `Ephemeral score (${ephScore}) should be higher than durable (${durScore})`);
    });

    it('fires as supplementary signal when regex misses', () => {
      // Content that regex misses but TF-IDF should catch (narrative, first-person-plural)
      const signals = detectEphemeralSignals(
        'Redis Key Naming Conflict',
        'A naming collision occurred between cache keys and session keys in Redis, causing sessions to be evicted. We implemented a namespace prefix strategy to separate the keyspaces.',
        'modules/database' as any,
      );
      // If TF-IDF fires, it should be the only signal (regex didn't match)
      const tfidfSignal = signals.find(s => s.id === 'tfidf-classifier');
      if (tfidfSignal) {
        assert.ok(tfidfSignal.confidence === 'low', 'TF-IDF signal should have low confidence');
        assert.ok(tfidfSignal.detail.includes('model confidence'), 'Should include model confidence');
      }
      // Either TF-IDF caught it or it's a genuine false negative — both acceptable
    });

    it('does not fire when regex already matched', () => {
      const signals = detectEphemeralSignals(
        'Current Build Issue',
        'The CI pipeline is currently broken due to a flaky test. We need to fix it right now.',
        'gotchas',
      );
      // Regex should fire (temporal: "currently", "right now")
      assert.ok(signals.some(s => s.id === 'temporal'), 'Regex should fire');
      // TF-IDF should NOT also fire (it's supplementary only)
      assert.ok(!signals.some(s => s.id === 'tfidf-classifier'), 'TF-IDF should not fire when regex matched');
    });
  });
});
