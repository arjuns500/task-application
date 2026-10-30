#!/usr/bin/env node
// tasks-tui: a terminal client for the Tasks server that keeps a local copy and works offline.
'use strict';
// node:sqlite prints an "experimental" warning on Node 22; keep it out of the terminal UI.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/.test(String(w?.message ?? w)) ? undefined : emitWarning.call(process, w, ...rest));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const S = require('../public/shared.js');
const M = require('./lib/model.js');
const { Store } = require('./lib/store.js');
const { Api, sync, SyncEngine } = require('./lib/sync.js');

const USAGE = `Usage: tasks-tui [command] [options]

Commands:
  (none)              open the full-screen UI
  sync                sync once and print what happened
  add <text...>       quick-add a task (works offline; sent on the next sync)
  agenda              print the agenda for the next 7 days
  log                 print the sync log (conflicts and rejected changes)
  config              save --server / --token for next time

Options:
  --server URL        server address, e.g. http://tasks.tailnet.ts.net:8080  (env TASKS_SERVER)
  --token TOKEN       API_TOKEN, if the server uses one                       (env TASKS_TOKEN)
  --db FILE           local database                                          (env TASKS_DB)
  --interval SECONDS  background sync interval in the UI (default 60)
  -h, --help`;

const xdg = (v, d) => process.env[v] || path.join(os.homedir(), d);
const CONFIG = path.join(xdg('XDG_CONFIG_HOME', '.config'), 'tasks-tui', 'config.json');

function main() {
  let a;
  try {
    a = parseArgs({ allowPositionals: true, options: { server: { type: 'string' }, token: { type: 'string' }, db: { type: 'string' },
      interval: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (e) { console.error(e.message + '\n\n' + USAGE); process.exit(2); }
  const { values: o, positionals: [cmd, ...args] } = a;
  if (o.help) return console.log(USAGE);

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  if (cmd === 'config') {
    for (const k of ['server', 'token', 'db']) if (o[k] != null) cfg[k] = o[k] || undefined;
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    return console.log(`Saved ${CONFIG}\n  server: ${cfg.server || '(none: local only)'}\n  token:  ${cfg.token ? 'set' : '(none)'}`);
  }

  const server = o.server ?? process.env.TASKS_SERVER ?? cfg.server;
  const token = o.token ?? process.env.TASKS_TOKEN ?? cfg.token;
  const dbFile = o.db ?? process.env.TASKS_DB ?? cfg.db ?? path.join(xdg('XDG_DATA_HOME', '.local/share'), 'tasks-tui', 'tasks.db');
  const store = new Store(dbFile);
  const api = server ? new Api({ server, token }) : null;
  const today = S.localToday();

  const syncOnce = async quiet => {
    if (!api) { if (!quiet) console.log('No server configured (use --server or `tasks-tui config --server URL`).'); return; }
    const before = store.logs(1)[0]?.id ?? 0;
    try {
      const r = await sync(store, api, today);
      if (!quiet) console.log(`Synced: sent ${r.pushed} change${r.pushed === 1 ? '' : 's'}, ${r.tasks} tasks on the server.`);
    } catch (e) {
      console.log(`Offline: ${e.status ? e.message : e.cause?.code || e.message}. ${store.pendingCount()} change(s) kept for later.`);
      process.exitCode = 1;
    }
    for (const l of store.logs(50).filter(l => l.id > before).reverse()) console.log('  ' + l.message);
  };

  switch (cmd) {
    case undefined: {
      if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('The UI needs a terminal. Try `tasks-tui agenda` or `tasks-tui sync`.'); process.exit(2); }
      const { App } = require('./lib/ui.js');
      const engine = new SyncEngine(store, api, { interval: (Number(o.interval) || 60) * 1000 });
      return new App(store, engine).start().then(async () => {
        if (api && store.pendingCount()) { api.timeout = 3000; await engine.run(); } // one quick last try to send local edits
        store.close();
        process.exit(0);
      });
    }
    case 'sync': return syncOnce(false).finally(() => store.close());
    case 'add': {
      const fields = S.parseQuickAdd(args.join(' '), today);
      if (!fields.title) { console.error('Usage: tasks-tui add <text>, e.g. tasks-tui add Call dentist @mon 10am !high'); process.exit(2); }
      const t = store.create(fields);
      console.log(`Added "${t.title}"${t.scheduled_date ? ` @${t.scheduled_date}` : ''}${t.deadline_date ? ` ^${t.deadline_date}` : ''}`);
      return syncOnce(true).finally(() => store.close());
    }
    case 'agenda': return syncOnce(true).then(() => {
      for (const day of M.agenda(store.all(), today, S.addDays(today, 6), today)) {
        console.log(`\n${day.date}${day.date === today ? '  (today)' : ''}`);
        for (const e of day.items) {
          const t = e.task;
          const label = e.kind === 'scheduled' ? (e.carried ? `Sched.${e.days}x:` : t.scheduled_time || 'Scheduled:')
            : e.carried ? (e.days < 0 ? `${-e.days} d. ago:` : `In ${e.days} d.:`) : 'Deadline:';
          console.log(`  ${label.padEnd(11)} ${t.done ? '[x]' : '[ ]'} ${t.title}${t.repeat ? '  ' + t.repeat : ''}`);
        }
      }
    }).finally(() => store.close());
    case 'log':
      for (const l of store.logs(100).reverse()) console.log(`${l.at}  ${l.message}`);
      return store.close();
    default:
      console.error(`Unknown command "${cmd}".\n\n${USAGE}`); process.exit(2);
  }
}

main();
