function normalizeTextMem(bucket = {}) {
  const cubeId = bucket.cube_id || bucket.cubeId || "text_mem";
  const memories = Array.isArray(bucket.memories) ? bucket.memories : [];
  return memories
    .map((item, index) => ({
      source: "memos",
      type: "text_mem",
      cubeId,
      score: Number(item.relativity ?? item.score ?? 0),
      text: item.memory || item.memory_value || item.memory_key || "",
      raw: item,
      rank: index,
    }))
    .filter((item) => item.text);
}

function normalizeGraphMem(type, bucket = {}) {
  const cubeId = bucket.cube_id || bucket.cubeId || type;
  const memories = Array.isArray(bucket.memories) ? bucket.memories : [];
  return memories
    .map((item, index) => ({
      source: "memos",
      type,
      cubeId,
      score: Number(item.relativity ?? item.score ?? 0),
      text: item.memory || item.preference || item.tool_value || item.memory_value || "",
      raw: item,
      rank: index,
    }))
    .filter((item) => item.text);
}

export function normalizeMemosSearchResult(result) {
  const data = result?.data?.data || result?.data?.result || result?.data || result?.result || {};

  const normalized = {
    textMem: [],
    prefMem: [],
    toolMem: [],
    skillMem: [],
    actMem: [],
    paraMem: [],
  };

  if (Array.isArray(data.text_mem)) {
    normalized.textMem = data.text_mem.flatMap((bucket) => normalizeTextMem(bucket));
  }
  if (Array.isArray(data.pref_mem)) {
    normalized.prefMem = data.pref_mem.flatMap((bucket) => normalizeGraphMem("pref_mem", bucket));
  }
  if (Array.isArray(data.tool_mem)) {
    normalized.toolMem = data.tool_mem.flatMap((bucket) => normalizeGraphMem("tool_mem", bucket));
  }
  if (Array.isArray(data.skill_mem)) {
    normalized.skillMem = data.skill_mem.flatMap((bucket) => normalizeGraphMem("skill_mem", bucket));
  }
  if (Array.isArray(data.act_mem)) {
    normalized.actMem = data.act_mem.flatMap((bucket) => normalizeGraphMem("act_mem", bucket));
  }
  if (Array.isArray(data.para_mem)) {
    normalized.paraMem = data.para_mem.flatMap((bucket) => normalizeGraphMem("para_mem", bucket));
  }

  normalized.summary = {
    textMem: normalized.textMem.length,
    prefMem: normalized.prefMem.length,
    toolMem: normalized.toolMem.length,
    skillMem: normalized.skillMem.length,
    actMem: normalized.actMem.length,
    paraMem: normalized.paraMem.length,
  };

  return normalized;
}
