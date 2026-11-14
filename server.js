require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const MCP_URL = "https://questathon.aihackerscollective.com/api/public/mcp";
const AQ_TOKEN = process.env.AQ_TOKEN?.trim();
const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const RATE_LIMIT_MS = 65_000;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let store = {
  updatedAt: null,
  lastMcpCallAt: 0,
  accountsExport: null,
  paperwork: {},
  files: {},
  flytbaseTeam: null,
  featureRequests: null,
  releaseNotes: null,
  notes: [],
  notesBootstrapped: false,
  signals: [],
  autoLoggedSignalIds: [],
  lastError: null,
};

if (fs.existsSync(STORE_PATH)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    store = {
      ...store,
      ...loaded,
      notes: Array.isArray(loaded.notes) ? loaded.notes : loaded.notes?.notes || [],
      signals: Array.isArray(loaded.signals) ? loaded.signals : [],
      autoLoggedSignalIds: Array.isArray(loaded.autoLoggedSignalIds)
        ? loaded.autoLoggedSignalIds
        : [],
    };
    console.log("Loaded cached CRM data.");
  } catch (err) {
    console.error("Could not parse data/store.json:", err.message);
  }
}

function saveStore() {
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

async function callMcpTool(name, args = {}) {
  if (!AQ_TOKEN) {
    throw new Error("Missing AQ_TOKEN environment variable on server.");
  }

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${AQ_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${rawText.slice(0, 200)}`);
  }

  const sseLine = rawText.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const rpcPayload = JSON.parse(sseLine ? sseLine.slice(6) : rawText);
  if (rpcPayload.error || rpcPayload.result?.isError) {
    throw new Error(
      rpcPayload.error?.message ||
        rpcPayload.result?.content?.[0]?.text ||
        "Unknown MCP tool error"
    );
  }

  const text = rpcPayload.result?.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

const writeQueue = [];

function getNextMcpJob() {
  if (writeQueue.length) return { type: "write_note", payload: writeQueue.shift() };
  if (!store.accountsExport) return { type: "get_my_accounts" };
  for (const account of store.accountsExport.accounts || []) {
    if (account.id && !store.paperwork[account.id]) {
      return { type: "get_all_paperwork", account: account.id };
    }
  }
  for (const file of store.accountsExport.files || []) {
    if (file.id && !store.files[file.id]) return { type: "get_file", id: file.id };
  }
  if (!store.flytbaseTeam) return { type: "get_flytbase_team" };
  if (!store.featureRequests) return { type: "get_feature_requests" };
  if (!store.releaseNotes) return { type: "get_release_notes" };
  if (!store.notesBootstrapped) return { type: "list_notes" };
  return { type: "get_signals" };
}

async function schedulerTick() {
  const now = Date.now();
  if (now - store.lastMcpCallAt < RATE_LIMIT_MS) return;

  const job = getNextMcpJob();
  if (!job) return;
  store.lastMcpCallAt = now;
  saveStore();

  try {
    if (job.type === "get_my_accounts") {
      store.accountsExport = await callMcpTool("get_my_accounts");
    } else if (job.type === "get_all_paperwork") {
      store.paperwork[job.account] = await callMcpTool("get_all_paperwork", {
        account: job.account,
      });
    } else if (job.type === "get_file") {
      store.files[job.id] = await callMcpTool("get_file", { id: job.id });
    } else if (job.type === "get_flytbase_team") {
      store.flytbaseTeam = await callMcpTool("get_flytbase_team");
    } else if (job.type === "get_feature_requests") {
      store.featureRequests = await callMcpTool("get_feature_requests");
    } else if (job.type === "get_release_notes") {
      store.releaseNotes = await callMcpTool("get_release_notes");
    } else if (job.type === "list_notes") {
      const result = await callMcpTool("list_notes");
      store.notes = Array.isArray(result) ? result : result.notes || [];
      store.notesBootstrapped = true;
    } else if (job.type === "get_signals") {
      const result = await callMcpTool("get_signals");
      const signals = Array.isArray(result) ? result : result.signals || result.events || [];
      store.signals = signals;

      for (const signal of signals) {
        const signalId = String(
          signal.id || signal.minute || signal.timestamp || JSON.stringify(signal)
        );
        if (!store.autoLoggedSignalIds.includes(signalId)) {
          store.autoLoggedSignalIds.push(signalId);
          writeQueue.push({
            account: signal.account || undefined,
            kind: "risk",
            title: `Live signal: ${signal.type || signal.title || "Account event"}`,
            text: `Automatically recorded signal [${signalId}]: ${
              signal.summary || signal.text || JSON.stringify(signal)
            }`,
          });
        }
      }
    } else if (job.type === "write_note") {
      const created = await callMcpTool("write_note", job.payload);
      store.notes.unshift({
        ...job.payload,
        ...(created && typeof created === "object" ? created : {}),
        saved_at: new Date().toISOString(),
      });
    }
    store.lastError = null;
  } catch (err) {
    console.error(`MCP job [${job.type}] failed:`, err.message);
    store.lastError = `${job.type}: ${err.message}`;
  } finally {
    saveStore();
  }
}

setInterval(schedulerTick, 5_000);
schedulerTick();

function getPaperworkRecord(accountId, recordPath) {
  const records = store.paperwork?.[accountId]?.records || [];
  return records.find((record) => record.path === recordPath) || null;
}

function analyzeWeeklyUsage(csvText) {
  if (!csvText) return { totalDocks: 0, zeroFlightDocks: [], activeDocks: [] };
  const lines = csvText.trim().split(/\r?\n/).slice(1);
  const flightsByDock = {};
  for (const line of lines) {
    const [, dockId, flights] = line.split(",");
    if (!dockId) continue;
    flightsByDock[dockId] = (flightsByDock[dockId] || 0) + Number(flights || 0);
  }
  const docks = Object.keys(flightsByDock);
  return {
    totalDocks: docks.length,
    zeroFlightDocks: docks.filter((dock) => flightsByDock[dock] === 0),
    activeDocks: docks.filter((dock) => flightsByDock[dock] > 0),
  };
}

function buildDashboardState() {
  const exportData = store.accountsExport || { accounts: [], files: [] };
  const sourceIndex = {};

  for (const file of exportData.files || []) {
    if (file.id) sourceIndex[file.id] = store.files[file.id] || file;
  }
  (store.signals || []).forEach((signal, index) => {
    sourceIndex[`signal:${signal.id || index}`] = signal;
  });

  const accounts = (exportData.accounts || []).map((account) => {
    const accountId = account.id;
    const stakeholders = Array.isArray(account.stakeholders) ? account.stakeholders : [];
    const opportunities = Array.isArray(account.opportunities) ? account.opportunities : [];
    const offers = Array.isArray(account.offers) ? account.offers : [];
    const usageRecord = getPaperworkRecord(accountId, "usage_weekly.csv");
    const usage = analyzeWeeklyUsage(usageRecord?.text);

    for (const record of store.paperwork?.[accountId]?.records || []) {
      sourceIndex[`${accountId}:${record.path}`] = record.data || record.text || record;
    }
    for (const item of [
      ...(account.facts || []),
      ...opportunities,
      ...offers,
      ...stakeholders,
    ]) {
      if (item.id) sourceIndex[`${accountId}:${item.id}`] = item;
    }

    const backedItems = offers
      .filter((offer) => offer.status === "won" || offer.status === "agreed")
      .map((offer) => ({
        id: offer.id,
        title: offer.title || "Confirmed offer",
        value: Number(offer.value) || 0,
        currency: "USD",
        category: "Won / agreed offer",
        backingNote: "Offer status is recorded as won or agreed.",
        sources: offer.id ? [`${accountId}:${offer.id}`] : [],
      }));

    const unbackedItems = [];
    for (const opportunity of opportunities) {
      if (opportunity.worth_up_to != null) {
        backedItems.push({
          id: opportunity.id,
          title: opportunity.title || "Qualified opportunity",
          value: Number(opportunity.worth_up_to) || 0,
          currency: "USD",
          category: `Opportunity${opportunity.stage ? ` · ${opportunity.stage}` : ""}`,
          backingNote: opportunity.blocker?.text || "A value is recorded for this opportunity.",
          sources: [
            ...(opportunity.id ? [`${accountId}:${opportunity.id}`] : []),
            ...(opportunity.evidence || []).map((id) =>
              store.files[id] ? id : `${accountId}:${id}`
            ),
          ],
        });
      } else {
        unbackedOpportunity(opportunity, accountId);
      }
    }

    function unbackedOpportunity(opportunity, id) {
      unbackedItems.push({
        id: opportunity.id,
        title: opportunity.title || "Unvalued opportunity",
        value: 0,
        currency: "USD",
        category: "Value not recorded",
        reason: opportunity.blocker?.text || "Confirm qualification, value, and timing.",
        sources: opportunity.id ? [`${id}:${opportunity.id}`] : [],
      });
    }

    for (const offer of offers) {
      if (offer.status !== "won" && offer.status !== "agreed") {
        unbackedItems.push({
          id: offer.id,
          title: offer.title || "Open offer",
          value: Number(offer.value) || 0,
          currency: "USD",
          category: "Open offer",
          reason: offer.reason || "Confirm prerequisites and approval status before proceeding.",
          sources: offer.id ? [`${accountId}:${offer.id}`] : [],
        });
      }
    }

    const backedTotal = backedItems.reduce((sum, item) => sum + item.value, 0);
    const unbackedTotal = unbackedItems.reduce(
      (sum, item) => sum + Number(item.value || 0),
      0
    );
    const deals = [
      ...opportunities.map((item) => ({
        ...item,
        type: "Opportunity",
        value: item.worth_up_to,
      })),
      ...offers.map((item) => ({ ...item, type: "Offer" })),
    ];

    const decisionCards = deals.slice(0, 6).map((deal) => ({
      dealTitle: `${deal.type}: ${deal.title || "Untitled deal"}`,
      decides: stakeholders[0]?.name || "Decision maker not recorded",
      pays: deal.payer || "Confirm the budget owner.",
      uses: deal.user || "Confirm day-to-day users.",
      blocks: deal.blocker?.text || "No blocker recorded.",
      sources: deal.id ? [`${accountId}:${deal.id}`] : [],
    }));
    if (!decisionCards.length) {
      decisionCards.push({
        dealTitle: "No deals recorded",
        decides: "Identify the decision maker.",
        pays: "Confirm the budget owner.",
        uses: "Identify day-to-day users.",
        blocks: "No blocker recorded.",
        sources: [],
      });
    }

    const nextMoves = deals.slice(0, 3).map((deal, index) => ({
      rank: index + 1,
      title: `Confirm next steps: ${deal.title || "Review account opportunity"}`,
      deal: deal.title || deal.type,
      owner: deal.owner || stakeholders[0]?.name || "Account owner",
      due: deal.due_date || "Set a target date with the account team.",
      sources: deal.id ? [`${accountId}:${deal.id}`] : [],
    }));

    const signals = (store.signals || []).filter(
      (signal) =>
        !signal.account ||
        String(signal.account).toLowerCase() === String(accountId).toLowerCase() ||
        String(signal.account).toLowerCase() === String(account.name || "").toLowerCase()
    );
    const risks = signals.map((signal) => {
      const sourceKey = `signal:${signal.id || store.signals.indexOf(signal)}`;
      return {
        severity: signal.severity || "LIVE SIGNAL",
        title: signal.title || signal.type || "Live account event",
        whenItTurnsBad: signal.timestamp || signal.due || "Review promptly.",
        detail: signal.summary || signal.text || "Review the linked source for details.",
        sources: [sourceKey],
      };
    });
    for (const opportunity of opportunities.filter((item) => item.blocker?.text)) {
      risks.push({
        severity: "REVIEW",
        title: opportunity.title || "Blocked opportunity",
        whenItTurnsBad: opportunity.due_date || "Review at the next account check-in.",
        detail: opportunity.blocker.text,
        sources: opportunity.id ? [`${accountId}:${opportunity.id}`] : [],
      });
    }
    if (!risks.length) {
      risks.push({
        severity: "LOW",
        title: "No active risks recorded",
        whenItTurnsBad: "Review at the next account check-in.",
        detail: "Add a risk note if new concerns arise.",
        sources: [],
      });
    }

    const gaps = opportunities
      .filter((item) => !item.evidence?.length)
      .slice(0, 3)
      .map((item) => ({
        gap: `Evidence for ${item.title || "this opportunity"}`,
        whyItMatters: "Supporting information helps validate value and readiness.",
        whoToAsk: stakeholders[0]?.name || "Account owner",
        sources: item.id ? [`${accountId}:${item.id}`] : [],
      }));
    if (!gaps.length) {
      gaps.push({
        gap: "Confirm the next account review date.",
        whyItMatters: "A scheduled review keeps owners and priorities aligned.",
        whoToAsk: stakeholders[0]?.name || "Account owner",
        sources: [],
      });
    }

    return {
      id: accountId,
      name: account.name || "Unnamed account",
      currency: "USD",
      symbol: "$",
      officialStory: account.official_story || "No account summary is available.",
      stakeholders,
      telemetrySummary: {
        totalDocks: usage.totalDocks,
        activeDocksCount: usage.activeDocks.length,
        zeroFlightDocks: usage.zeroFlightDocks,
      },
      q1: { backedTotal, unbackedTotal, backedItems, unbackedItems },
      q2: decisionCards,
      q3: nextMoves,
      q4: risks,
      q5: gaps,
    };
  });

  return {
    meta: {
      exportedAt: exportData.exported_at,
      minute: exportData.minute,
      worldClosed: exportData.world_closed,
      nextMcpSyncInSec: Math.max(
        0,
        Math.ceil((RATE_LIMIT_MS - (Date.now() - store.lastMcpCallAt)) / 1000)
      ),
      pendingWrites: writeQueue.length,
      signalCount: (store.signals || []).length,
      noteCount: (store.notes || []).length,
      lastError: store.lastError,
    },
    accounts,
    signals: store.signals || [],
    notes: store.notes || [],
    flytbaseTeam: store.flytbaseTeam?.people || [],
    releaseNotes: store.releaseNotes?.releases || [],
    sourceIndex,
  };
}

app.get("/api/crm", (_req, res) => {
  res.json(buildDashboardState());
});

app.post("/api/notes", (req, res) => {
  const { account, kind = "next_step", title = "CRM Action", text } = req.body || {};
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Note text is required." });
  }
  writeQueue.push({
    account: account || undefined,
    kind,
    title: typeof title === "string" && title.trim() ? title.trim() : "CRM Action",
    text: text.trim(),
  });
  res.json({ queued: true, queueLength: writeQueue.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FlytBase Live CRM running at http://localhost:${PORT}`);
});
