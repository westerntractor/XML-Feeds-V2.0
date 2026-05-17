const { webflowRequest } = require("./rateLimit");
const axios = require("axios");

const PUBLISH_CHUNK_SIZE = parseInt(process.env.PUBLISH_CHUNK_SIZE || "50", 10);
const JOB_TTL_MS = 60 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

function createJob(itemIds) {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const uniqueIds = [...new Set(itemIds)];
  const job = {
    id: jobId,
    status: "pending",
    total: uniqueIds.length,
    processed: 0,
    publishedItemIds: [],
    errors: [],
    createdAt: Date.now(),
    finishedAt: null,
    error: null,
    _itemIds: uniqueIds,
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
    publishedItemIds: job.publishedItemIds,
    errors: job.errors,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

async function runPublishJob(job, collectionId, webflowConfig) {
  job.status = "running";
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items/publish`;
  const itemIds = job._itemIds;

  try {
    for (let i = 0; i < itemIds.length; i += PUBLISH_CHUNK_SIZE) {
      const chunk = itemIds.slice(i, i + PUBLISH_CHUNK_SIZE);
      const chunkNum = Math.floor(i / PUBLISH_CHUNK_SIZE) + 1;
      const result = await webflowRequest(
        () => axios.post(url, { itemIds: chunk }, webflowConfig),
        { label: `job-${job.id}-chunk-${chunkNum}` }
      );
      if (result.data?.publishedItemIds) {
        job.publishedItemIds.push(...result.data.publishedItemIds);
      }
      if (result.data?.errors?.length) {
        job.errors.push(...result.data.errors);
      }
      job.processed = Math.min(i + chunk.length, itemIds.length);
    }
    job.status = "done";
    job.processed = itemIds.length;
    console.log(`Publish job ${job.id} done: ${job.publishedItemIds.length} published`);
  } catch (e) {
    job.status = "failed";
    job.error = e.response?.data?.message || e.message;
    console.error(`Publish job ${job.id} failed:`, job.error);
  } finally {
    job.finishedAt = Date.now();
    delete job._itemIds;
  }
}

function startPublishJob(itemIds, collectionId, webflowConfig) {
  pruneOldJobs();
  const job = createJob(itemIds);

  setImmediate(() => {
    runPublishJob(job, collectionId, webflowConfig);
  });

  return job;
}

async function publishItemsSync(itemIds, collectionId, webflowConfig) {
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items/publish`;
  const uniqueIds = [...new Set(itemIds)];
  const published = [];
  const errors = [];

  for (let i = 0; i < uniqueIds.length; i += PUBLISH_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + PUBLISH_CHUNK_SIZE);
    const result = await webflowRequest(
      () => axios.post(url, { itemIds: chunk }, webflowConfig),
      { label: `cms-publish-chunk-${Math.floor(i / PUBLISH_CHUNK_SIZE) + 1}` }
    );
    if (result.data?.publishedItemIds) {
      published.push(...result.data.publishedItemIds);
    }
    if (result.data?.errors?.length) {
      errors.push(...result.data.errors);
    }
  }

  return { publishedItemIds: published, errors };
}

module.exports = {
  PUBLISH_CHUNK_SIZE,
  getJob,
  startPublishJob,
  publishItemsSync,
  publicJobView,
};
