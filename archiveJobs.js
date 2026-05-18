const JOB_TTL_MS = 60 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

function createJob(incomingUniqueIds) {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const job = {
    id: jobId,
    status: "pending",
    total: 0,
    processed: 0,
    archivedItemIds: [],
    errors: [],
    createdAt: Date.now(),
    finishedAt: null,
    error: null,
    _incomingUniqueIds: incomingUniqueIds,
  };
  jobs.set(jobId, job);
  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

function publicJobView(job) {
  return {
    jobId: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    archivedItemIds: job.archivedItemIds,
    errors: job.errors,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

async function runArchiveJob(job, ctx) {
  job.status = "running";

  try {
    const incoming = new Set(job._incomingUniqueIds.map((id) => String(id)));
    const items = await ctx.getAllCollectionItems();
    const { duplicateItemIds } = ctx.buildInventoryData(items);

    const toArchive = [...duplicateItemIds];

    for (const item of items) {
      if (item.isArchived) continue;
      const uniqueId = item.fieldData?.["unique-id"];
      if (uniqueId == null) continue;
      if (!incoming.has(String(uniqueId))) {
        toArchive.push(item.id);
      }
    }

    const uniqueToArchive = [...new Set(toArchive)];
    job.total = uniqueToArchive.length;

    for (let i = 0; i < uniqueToArchive.length; i++) {
      const itemId = uniqueToArchive[i];
      try {
        await ctx.archiveItemById(itemId, `archive-job-${job.id}:${i + 1}`);
        job.archivedItemIds.push(itemId);
        console.log(`Archive job ${job.id}: archived ${itemId}`);
      } catch (e) {
        job.errors.push({
          itemId,
          error: e.response?.data || e.message,
        });
      }
      job.processed = i + 1;
    }

    job.status = "done";
    console.log(
      `Archive job ${job.id} done: ${job.archivedItemIds.length} archived`
    );
  } catch (e) {
    job.status = "failed";
    job.error = e.response?.data?.message || e.message;
    console.error(`Archive job ${job.id} failed:`, job.error);
  } finally {
    job.finishedAt = Date.now();
    delete job._incomingUniqueIds;
  }
}

function startArchiveJob(incomingUniqueIds, ctx) {
  pruneOldJobs();
  const job = createJob(incomingUniqueIds);

  setImmediate(() => {
    runArchiveJob(job, ctx);
  });

  return job;
}

module.exports = {
  getJob,
  startArchiveJob,
  publicJobView,
};
