const pendingSaves = new Map<string, Promise<unknown>>();

export function queueAgentFileSave<Result>(
  projectId: string,
  fileId: string,
  save: () => Promise<Result>,
): Promise<Result> {
  const key = JSON.stringify([projectId, fileId]);
  const previous = pendingSaves.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(save);
  pendingSaves.set(key, pending);

  return pending.finally(() => {
    if (pendingSaves.get(key) === pending) pendingSaves.delete(key);
  });
}