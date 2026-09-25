// Preloaded into the `archstrict check` child by analyze.mjs: writes the
// process's peak RSS (KB) to SURVEY_RSS_OUT when it exits.
process.on("exit", () => {
  try { require("node:fs").writeFileSync(process.env.SURVEY_RSS_OUT, String(process.resourceUsage().maxRSS)); } catch {}
});
