(function exposeOnlinePlayerAdminState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OnlinePlayerAdminState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createOnlinePlayerAdminState() {
  'use strict';

  function captureSaveAttempt({ serverId, identityId, generation, note, expectedVersion }) {
    return Object.freeze({
      serverId: String(serverId),
      identityId: Number(identityId),
      generation: Number(generation),
      note: String(note),
      expectedVersion: Number(expectedVersion),
    });
  }

  function isCurrentContext(attempt, current) {
    return attempt.serverId === String(current?.serverId) &&
      attempt.generation === Number(current?.generation);
  }

  function isCurrentServer(attempt, currentServerId) {
    return attempt.serverId === String(currentServerId);
  }

  function shouldDiscardDraft(attempt, currentNote) {
    return attempt.note === String(currentNote);
  }

  function createSaveCoordinator() {
    const pending = new Map();
    return Object.freeze({
      isPending(key) {
        return pending.has(String(key));
      },
      async run({ key, attempt, request, isCurrent, refresh, onSettled }) {
        const normalizedKey = String(key);
        if (pending.has(normalizedKey)) return false;
        pending.set(normalizedKey, attempt);
        let error = null;
        try {
          await request();
          if (!isCurrent()) return true;
          await refresh();
        } catch (caught) {
          error = caught;
          if (isCurrent() && caught.refreshRequired) await refresh();
        } finally {
          pending.delete(normalizedKey);
          if (isCurrent()) onSettled(error);
        }
        return true;
      },
    });
  }

  return Object.freeze({
    captureSaveAttempt,
    isCurrentContext,
    isCurrentServer,
    shouldDiscardDraft,
    createSaveCoordinator,
  });
});
