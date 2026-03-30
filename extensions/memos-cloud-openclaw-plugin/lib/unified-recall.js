function normalizeLancedbResult(item, index) {
  return {
    source: "lancedb",
    type: item.category || "fact",
    text: item.text || "",
    score: Number(item.score ?? 0),
    timestamp: item.timestamp || 0,
    rank: index,
    raw: item,
  };
}

function normalizeMemosItem(item, index) {
  return {
    source: item.source || "memos",
    type: item.type || "text_mem",
    text: item.text || "",
    score: Number(item.score ?? 0),
    timestamp: item.raw?.create_time || item.raw?.timestamp || 0,
    rank: index,
    raw: item,
  };
}

export function buildUnifiedRecallResults(lancedbResults = [], normalizedMemos = null, options = {}) {
  const { topK = null } = options;
  const lancedb = [];
  const memos = [];

  for (const [index, item] of lancedbResults.entries()) {
    if (!item?.text) continue;
    lancedb.push(normalizeLancedbResult(item, index));
  }

  const memosLists = [
    ...(normalizedMemos?.textMem || []).map((item) => ({ ...item, type: item.type || "text_mem" })),
    ...(normalizedMemos?.prefMem || []).map((item) => ({ ...item, type: item.type || "pref_mem" })),
    ...(normalizedMemos?.toolMem || []).map((item) => ({ ...item, type: item.type || "tool_mem" })),
    ...(normalizedMemos?.skillMem || []).map((item) => ({ ...item, type: item.type || "skill_mem" })),
    ...(normalizedMemos?.actMem || []).map((item) => ({ ...item, type: item.type || "act_mem" })),
    ...(normalizedMemos?.paraMem || []).map((item) => ({ ...item, type: item.type || "para_mem" })),
  ];

  for (const [index, item] of memosLists.entries()) {
    if (!item?.text) continue;
    memos.push(normalizeMemosItem(item, index));
  }

  const sorter = (a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.timestamp || 0) !== (a.timestamp || 0)) return (b.timestamp || 0) - (a.timestamp || 0);
    if (a.source !== b.source) return a.source === "lancedb" ? -1 : 1;
    return a.rank - b.rank;
  };

  lancedb.sort(sorter);
  memos.sort(sorter);

  if (!Number.isFinite(topK) || topK <= 0) {
    return [...lancedb, ...memos].sort(sorter);
  }

  const total = Math.floor(topK);
  const lancedbQuota = Math.min(lancedb.length, Math.ceil(total / 2));
  const memosQuota = Math.min(memos.length, Math.floor(total / 2));

  const selectedLancedb = lancedb.slice(0, lancedbQuota);
  const selectedMemos = memos.slice(0, memosQuota);
  const remaining = total - selectedLancedb.length - selectedMemos.length;

  if (remaining > 0) {
    const lancedbRest = lancedb.slice(selectedLancedb.length);
    const memosRest = memos.slice(selectedMemos.length);
    const extras = [...lancedbRest, ...memosRest].sort(sorter).slice(0, remaining);
    return interleaveRecallResults(selectedLancedb, selectedMemos, total).concat(extras).slice(0, total);
  }

  return interleaveRecallResults(selectedLancedb, selectedMemos, total);
}

function interleaveRecallResults(lancedb = [], memos = [], topK = Infinity) {
  const merged = [];
  let li = 0;
  let mi = 0;

  while (merged.length < topK && (li < lancedb.length || mi < memos.length)) {
    if (li < lancedb.length) merged.push(lancedb[li++]);
    if (merged.length >= topK) break;
    if (mi < memos.length) merged.push(memos[mi++]);
  }

  return merged.slice(0, topK);
}

export function summarizeUnifiedRecall(unifiedResults = [], topK = 6) {
  return unifiedResults.slice(0, topK).map((item) => ({
    source: item.source,
    type: item.type,
    score: Number(item.score ?? 0),
    text: (item.text || "").slice(0, 120),
  }));
}
