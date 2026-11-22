// Native permission is scoped to the linked server/device and a canonical folder.
function createFolderTrust({ read, remember, confirm }) {
  let pending = Promise.resolve(),
    epoch = 0;
  return {
    invalidate() {
      epoch++;
    },
    approve(root) {
      const identity = read().identity,
        generation = epoch;
      const next = pending.then(async () => {
        const current = read();
        if (!identity || current.identity !== identity || generation !== epoch)
          return false;
        if (current.folders.includes(root)) return true;
        if (!(await confirm(root))) return false;
        if (read().identity !== identity || generation !== epoch) return false;
        await remember(root);
        return true;
      });
      pending = next.catch(() => false);
      return next;
    },
  };
}
module.exports = { createFolderTrust };
