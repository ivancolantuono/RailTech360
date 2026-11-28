import 'dotenv/config';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';

// ======================================================
// 1. CONFIGURAZIONE
// ======================================================

const train = String(
  process.argv[2] || process.env.TELEDIA_TRAIN || '102'
).replace(/\D/g, '');

if (!train) throw new Error('Numero treno non valido.');

const vehicleId = `etr1001cst${train}`;
const loginUrl = process.env.TELEDIA_LOGIN_URL;
const fleetUrl = process.env.TELEDIA_FLEET_URL;
const username = process.env.TELEDIA_USERNAME;
const password = process.env.TELEDIA_PASSWORD;

if (!loginUrl) throw new Error('TELEDIA_LOGIN_URL mancante.');
if (!fleetUrl) throw new Error('TELEDIA_FLEET_URL mancante.');
if (!username || !password) {
  throw new Error('TELEDIA_USERNAME o TELEDIA_PASSWORD mancanti.');
}

const cfg = {
  subsystem: process.env.FILTER_SUBSYSTEM || 'Trazione',
  eventName: process.env.FILTER_EVENT_NAME || '*dia*',
  description: process.env.FILTER_DESCRIPTION || '*apertura*',
  days: Number(process.env.FILTER_DAYS || 10)
};

if (!Number.isFinite(cfg.days) || cfg.days <= 0) {
  throw new Error('FILTER_DAYS non valido.');
}

const now = new Date();
const cutoff = new Date(
  now.getTime() - cfg.days * 24 * 60 * 60 * 1000
);

const FIELD_IDS = {
  from: 'rdpDaData_dateInput',
  to: 'rdpAData_dateInput',
  subsystem: 'rtbSubSystem'
};

// ======================================================
// 2. FUNZIONI GENERALI
// ======================================================

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\*/g, '')
    .trim();
}

function formatDate(date) {
  const pad = n => String(n).padStart(2, '0');

  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseItalianDate(value) {
  const m = String(value || '').match(
    /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/
  );

  if (!m) return null;

  return new Date(
    Number(m[3]),
    Number(m[2]) - 1,
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0)
  );
}

async function saveDebug(filename, data) {
  await fs.mkdir('output', { recursive: true });

  await fs.writeFile(
    path.join('output', filename),
    JSON.stringify(data, null, 2)
  );
}

// ======================================================
// 3. AVVIO BROWSER E LOGIN AUTOMATICO
// ======================================================

const browser = await chromium.launch({
  headless: String(process.env.HEADLESS).toLowerCase() === 'true'
});

const context = await browser.newContext({
  ignoreHTTPSErrors: true
});

const page = await context.newPage();
page.setDefaultTimeout(15000);

async function loginToTelediagnostica() {
  console.log('Apro la pagina di login Telediagnostica...');

  await page.goto(loginUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.locator('#LoginUser_UserName').fill(username);
  await page.locator('#LoginUser_Password').fill(password);

  console.log('Invio le credenziali al portale...');

  await page.locator('#LoginUser_LoginButton').click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);

  if (/login\.aspx/i.test(page.url())) {
    throw new Error(
      'Login non riuscito: il portale mostra ancora la pagina di accesso.'
    );
  }

  console.log('Login completato.');
}

// ======================================================
// 4. SCORRIMENTO E RICERCA TRENO
// ======================================================

async function scrollFrame(frame) {
  try {
    return await frame.evaluate(() => {
      const elements = [
        document.scrollingElement,
        ...document.querySelectorAll('*')
      ].filter(Boolean);

      const candidates = elements.filter(el => {
        const style = getComputedStyle(el);

        return el.scrollHeight > el.clientHeight + 10 &&
          /(auto|scroll)/.test(
            `${style.overflow} ${style.overflowY}`
          );
      });

      candidates.sort((a, b) =>
        (b.scrollHeight - b.clientHeight) -
        (a.scrollHeight - a.clientHeight)
      );

      for (const el of candidates) {
        const before = el.scrollTop;

        el.scrollTop = Math.min(
          before + Math.max(300, el.clientHeight * 0.7),
          el.scrollHeight
        );

        if (el.scrollTop > before) return true;
      }

      const root = document.scrollingElement;

      if (root && root.scrollTop < root.scrollHeight) {
        const before = root.scrollTop;
        root.scrollTop += window.innerHeight * 0.7;
        return root.scrollTop > before;
      }

      return false;
    });
  } catch {
    return false;
  }
}

async function findAndClickText(text, maxScrolls = 60) {
  for (let step = 0; step <= maxScrolls; step++) {
    for (const frame of page.frames()) {
      try {
        const locator = frame.getByText(text, { exact: true });
        const count = await locator.count();

        for (let i = 0; i < count; i++) {
          const item = locator.nth(i);

          if (await item.isVisible().catch(() => false)) {
            await item.scrollIntoViewIfNeeded().catch(() => {});
            await item.click({ timeout: 7000 });
            return true;
          }
        }
      } catch {
        // Prova il frame successivo.
      }
    }

    if (step === maxScrolls) break;

    let moved = false;

    for (const frame of page.frames()) {
      if (await scrollFrame(frame)) moved = true;
    }

    if (!moved) break;

    await page.waitForTimeout(300);
  }

  return false;
}

// ======================================================
// 5. CLIC SU SCHEDE E CRITERI
// ======================================================

async function clickVisibleText(text) {
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(text => {
        const clean = value => String(value || '')
          .replace(/\s+/g, ' ')
          .trim();

        const elements = [
          ...document.querySelectorAll(
            'a, span, button, div, li, td, [role="tab"]'
          )
        ];

        const candidates = elements.filter(el =>
          clean(el.innerText || el.textContent) === text &&
          el.getClientRects().length > 0
        );

        candidates.sort((a, b) =>
          a.getBoundingClientRect().width *
          a.getBoundingClientRect().height -
          b.getBoundingClientRect().width *
          b.getBoundingClientRect().height
        );

        for (const el of candidates) {
          const clickable = el.closest(
            'a, button, [role="tab"], .rtsLink, .rmLink'
          ) || el;

          const style = getComputedStyle(clickable);

          if (
            style.display === 'none' ||
            style.visibility === 'hidden'
          ) continue;

          clickable.click();
          return true;
        }

        return false;
      }, text);

      if (result) return true;
    } catch {
      // Continua con il frame successivo.
    }
  }

  return false;
}

async function clickTab(name) {
  console.log(`Apro scheda ${name}...`);

  if (!(await clickVisibleText(name))) {
    throw new Error(`Scheda ${name} non trovata.`);
  }

  await page.waitForTimeout(800);
}

async function openCriterion(name) {
  console.log(`Apro criterio ${name}...`);

  if (!(await clickVisibleText(name))) {
    throw new Error(`Criterio ${name} non trovato.`);
  }

  await page.waitForTimeout(600);
}

async function closeCriterion(name) {
  console.log(`Richiudo criterio ${name}...`);

  if (!(await clickVisibleText(name))) {
    throw new Error(`Impossibile richiudere ${name}.`);
  }

  await page.waitForTimeout(600);
}

// ======================================================
// 6. COMPILAZIONE DATE E SOTTOSISTEMA
// ======================================================

async function setKnownField(suffix, value, label) {
  for (const frame of page.frames()) {
    try {
      const locator = frame.locator(
        `input[id$="${suffix}"]`
      ).first();

      if (
        await locator.count() &&
        await locator.isVisible()
      ) {
        await locator.fill(value);
        await locator.press('Tab').catch(() => {});

        const actual = await locator.inputValue();

        console.log(`Campo ${label}:`, {
          id: await locator.getAttribute('id'),
          value: actual
        });

        if (actual !== value) {
          throw new Error(
            `Valore errato nel campo ${label}.`
          );
        }

        return true;
      }
    } catch (error) {
      if (error.message.includes('Valore errato')) {
        throw error;
      }
    }
  }

  throw new Error(
    `Campo ${label} non trovato tramite ID ${suffix}.`
  );
}

async function readKnownField(suffix) {
  for (const frame of page.frames()) {
    try {
      const locator = frame.locator(
        `input[id$="${suffix}"]`
      ).first();

      if (
        await locator.count() &&
        await locator.isVisible()
      ) {
        return await locator.inputValue();
      }
    } catch {
      // Continua.
    }
  }

  return null;
}

// ======================================================
// 7. COMPILAZIONE NOME PARZIALE E DESCRIZIONE PARZIALE
// ======================================================

async function setPartialField(caption, value) {
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(
        ({ caption, value }) => {
          const norm = text => String(text || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT
          );

          const labels = [];

          while (walker.nextNode()) {
            const node = walker.currentNode;

            if (norm(node.nodeValue) !== norm(caption)) {
              continue;
            }

            const element = node.parentElement;
            if (!element) continue;

            const rect = element.getBoundingClientRect();

            if (rect.width > 0 && rect.height > 0) {
              labels.push(rect);
            }
          }

          const inputs = [
            ...document.querySelectorAll(
              'input:not([type="hidden"]), textarea'
            )
          ].filter(input => {
            const rect = input.getBoundingClientRect();
            const style = getComputedStyle(input);
            const type = (input.type || '').toLowerCase();

            return rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              ![
                'button',
                'submit',
                'checkbox',
                'radio',
                'image'
              ].includes(type);
          });

          let best = null;
          let bestScore = Infinity;

          for (const label of labels) {
            for (const input of inputs) {
              const rect = input.getBoundingClientRect();

              const verticalGap = rect.top - label.bottom;
              const horizontalGap = Math.abs(
                rect.left - label.left
              );

              if (
                verticalGap < -8 ||
                verticalGap > 100 ||
                horizontalGap > 350
              ) continue;

              const score =
                Math.max(0, verticalGap) * 3 +
                horizontalGap;

              if (score < bestScore) {
                bestScore = score;
                best = input;
              }
            }
          }

          if (!best) {
            return {
              success: false,
              reason: 'Campo non trovato sotto etichetta',
              labels: labels.length,
              inputs: inputs.map(input => ({
                id: input.id,
                name: input.name,
                value: input.value
              }))
            };
          }

          best.focus();

          const prototype =
            best.tagName === 'TEXTAREA'
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;

          const setter = Object.getOwnPropertyDescriptor(
            prototype,
            'value'
          ).set;

          setter.call(best, value);

          best.dispatchEvent(
            new Event('input', { bubbles: true })
          );

          best.dispatchEvent(
            new Event('change', { bubbles: true })
          );

          best.blur();

          return {
            success: best.value === value,
            id: best.id,
            name: best.name,
            value: best.value
          };
        },
        { caption, value }
      );

      console.log(`Campo ${caption}:`, result);

      if (result.success) {
        return result.value;
      }

      await saveDebug(
        `debug-${caption.replace(/\s+/g, '-')}.json`,
        result
      );
    } catch (error) {
      console.log(
        `Errore campo ${caption}:`,
        error.message
      );
    }
  }

  throw new Error(
    `Impossibile compilare il campo ${caption}.`
  );
}

// ======================================================
// 8. PULSANTE CERCA
// ======================================================

async function clickSearchButton() {
  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate(() => {
        const clean = text => String(text || '')
          .replace(/\s+/g, ' ')
          .trim();

        const elements = [
          ...document.querySelectorAll(
            'button, input[type="button"], input[type="submit"], a'
          )
        ];

        const target = elements.find(el => {
          const text = clean(
            el.innerText || el.value || el.textContent
          );

          return text === 'Cerca' &&
            el.getClientRects().length > 0 &&
            !el.disabled;
        });

        if (!target) return false;

        target.click();
        return true;
      });

      if (clicked) return true;
    } catch {
      // Continua.
    }
  }

  return false;
}

// ======================================================
// 9. ESTRAZIONE EVENTI
// ======================================================

async function readEvents() {
  const collected = new Map();
  const frameDebug = [];

  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(vehicleId => {
        const clean = value => String(value ?? '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const datePattern =
          /\b\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}/;

        const found = [];

        for (const tr of document.querySelectorAll('tr')) {
          const cells = [
            ...tr.querySelectorAll(':scope > td, :scope > th')
          ].map(cell => clean(cell.innerText));

          if (cells.length < 18) continue;

          const hasVehicle = cells.some(value =>
            value.toLowerCase() === vehicleId.toLowerCase()
          );

          const hasDate = cells.some(value =>
            datePattern.test(value)
          );

          if (hasVehicle && hasDate) {
            found.push(cells);
          }
        }

        return {
          url: location.href,
          title: document.title,
          rows: found,
          tableCount: document.querySelectorAll('table').length
        };
      }, vehicleId);

      frameDebug.push({
        url: result.url,
        title: result.title,
        rows: result.rows.length,
        tables: result.tableCount
      });

      for (const row of result.rows) {
        collected.set(row.join('|'), row);
      }
    } catch (error) {
      frameDebug.push({
        url: frame.url(),
        error: error.message
      });
    }
  }

  await saveDebug(
    `train-${train}-frames-debug.json`,
    frameDebug
  );

  return [...collected.values()];
}
// ======================================================
// 10. PROCEDURA PRINCIPALE
// ======================================================

try {
  console.log('====================================');
  console.log('AVVIO TELEDIAGNOSTICA');
  console.log(`TRENO: ${train}`);
  console.log('====================================');

  // LOGIN AUTOMATICO E APERTURA FLOTTA

  await loginToTelediagnostica();

  console.log('Apro la pagina della flotta...');

  await page.goto(fleetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(1500);

  if (/login\.aspx/i.test(page.url())) {
    throw new Error(
      'Il portale ha richiesto nuovamente il login.'
    );
  }

  // RICERCA TRENO

  console.log(`Cerco automaticamente ${vehicleId}...`);

  const vehicleFound = await findAndClickText(
    vehicleId,
    Number(process.env.MAX_VEHICLE_SCROLLS || 60)
  );

  if (!vehicleFound) {
    throw new Error(`Treno ${vehicleId} non trovato.`);
  }

  console.log(`Treno ${vehicleId} selezionato.`);

  await page.waitForLoadState('domcontentloaded')
    .catch(() => {});

  await page.waitForTimeout(1200);

  // ----------------------------------------------------
  // FASE 1: VEICOLI - DATE E SOTTOSISTEMA
  // ----------------------------------------------------

  console.log('');
  console.log('====================================');
  console.log('FASE 1 - DATE E SOTTOSISTEMA');
  console.log('====================================');

  await clickTab('Veicoli');

  const dateFrom = formatDate(cutoff);
  const dateTo = formatDate(now);

  console.log('Da:', dateFrom);
  console.log('A:', dateTo);
  console.log('Sottosistema:', cfg.subsystem);

  await setKnownField(
    FIELD_IDS.from,
    dateFrom,
    'Da'
  );

  await setKnownField(
    FIELD_IDS.to,
    dateTo,
    'A'
  );

  await setKnownField(
    FIELD_IDS.subsystem,
    cfg.subsystem,
    'Sottosistema'
  );

  const initialChecks = [
    {
      field: 'Da',
      expected: dateFrom,
      actual: await readKnownField(FIELD_IDS.from)
    },
    {
      field: 'A',
      expected: dateTo,
      actual: await readKnownField(FIELD_IDS.to)
    },
    {
      field: 'Sottosistema',
      expected: cfg.subsystem,
      actual: await readKnownField(FIELD_IDS.subsystem)
    }
  ].map(item => ({
    ...item,
    matches: item.expected === item.actual
  }));

  console.log('Verifica date e sottosistema:', initialChecks);

  if (!initialChecks.every(item => item.matches)) {
    await saveDebug('teledia-initial-check.json', initialChecks);

    throw new Error(
      'Date o sottosistema non verificati. Procedura interrotta.'
    );
  }

  // ----------------------------------------------------
  // FASE 2: EVENTI - NOME E DESCRIZIONE
  // ----------------------------------------------------

  console.log('');
  console.log('====================================');
  console.log('FASE 2 - FILTRI EVENTI');
  console.log('====================================');

  await clickTab('Eventi');

  // NOME EVENTO

  console.log('');
  await openCriterion('Nome evento');

  console.log('Inserisco Nome parziale:', cfg.eventName);

  const nameActual = await setPartialField(
    'Nome parziale',
    cfg.eventName
  );

  if (nameActual !== cfg.eventName) {
    throw new Error('Nome parziale non verificato.');
  }

  // Chiude Nome evento prima di aprire Descrizione.

  await closeCriterion('Nome evento');

  // DESCRIZIONE EVENTO

  console.log('');
  await openCriterion('Descrizione evento');

  console.log(
    'Inserisco Descrizione parziale:',
    cfg.description
  );

  const descriptionActual = await setPartialField(
    'Descrizione parziale',
    cfg.description
  );

  if (descriptionActual !== cfg.description) {
    throw new Error('Descrizione parziale non verificata.');
  }

  // ----------------------------------------------------
  // VERIFICA COMPLETA DEI CINQUE FILTRI
  // ----------------------------------------------------

  const finalChecks = [
    ...initialChecks,
    {
      field: 'Nome parziale',
      expected: cfg.eventName,
      actual: nameActual,
      matches: nameActual === cfg.eventName
    },
    {
      field: 'Descrizione parziale',
      expected: cfg.description,
      actual: descriptionActual,
      matches: descriptionActual === cfg.description
    }
  ];

  console.log('');
  console.log('VERIFICA COMPLETA DEI CINQUE FILTRI:');
  console.log(finalChecks);

  await saveDebug(
    'teledia-filter-check.json',
    finalChecks
  );

  if (!finalChecks.every(item => item.matches)) {
    throw new Error(
      'Verifica dei filtri non superata. Ricerca non avviata.'
    );
  }

  console.log('TUTTI E CINQUE I FILTRI SONO CORRETTI.');

  // ----------------------------------------------------
  // AVVIO RICERCA
  // ----------------------------------------------------

  if (!(await clickSearchButton())) {
    throw new Error('Pulsante Cerca non trovato.');
  }

  console.log('Pulsante Cerca premuto.');

  await page.waitForTimeout(4000);

  // ----------------------------------------------------
  // ESTRAZIONE RISULTATI
  // ----------------------------------------------------

  const rawRows = await readEvents();

  console.log(`Righe estratte: ${rawRows.length}`);

  // ----------------------------------------------------
  // MAPPATURA COLONNE
  // ----------------------------------------------------

  const events = rawRows.map(row => ({
    vehicle: row[3] || vehicleId,
    train_number: train,
    composition: row[4] || '',
    coach: row[6] || '',
    processor: row[8] || '',
    event_id: row[9] || '',
    subsystem: row[10] || '',
    start_at_raw: row[11] || '',
    end_at_raw: row[12] || '',
    duration_seconds: row[13] || '',
    error_code: row[14] || '',
    priority: row[15] || '',
    event_name: row[16] || '',
    description: row[17] || '',
    position: row[18] || '',
    speed_kmh: row[19] || '',
    raw_row: row
  }));

  // ----------------------------------------------------
  // FILTRO FINALE LOCALE
  // ----------------------------------------------------

  const matches = events.filter(event => {
    const nameOk = normalize(event.event_name)
      .includes(normalize(cfg.eventName));

    const descriptionOk = normalize(event.description)
      .includes(normalize(cfg.description));

    const subsystemOk =
      normalize(event.subsystem) === normalize(cfg.subsystem);

    const startDate = parseItalianDate(event.start_at_raw);

    const dateOk = startDate &&
      startDate >= cutoff &&
      startDate <= now;

    return nameOk &&
      descriptionOk &&
      subsystemOk &&
      dateOk;
  }).map(event => ({
    ...event,
    status: 'Da validare',
    source: 'Telediagnostica',
    captured_at: new Date().toISOString()
  }));

  // ----------------------------------------------------
  // SALVATAGGIO JSON
  // ----------------------------------------------------

  await fs.mkdir('output', { recursive: true });

  await fs.writeFile(
    `output/train-${train}-raw.json`,
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      vehicleId,
      url: page.url(),
      rowCount: events.length,
      rows: events
    }, null, 2)
  );

  await fs.writeFile(
    `output/train-${train}-filtered.json`,
    JSON.stringify({
      train,
      criteria: cfg,
      cutoff: cutoff.toISOString(),
      totalRows: events.length,
      matched: matches.length,
      events: matches
    }, null, 2)
  );

  await page.screenshot({
    path: `output/train-${train}-results.png`,
    fullPage: true
  });

  // ----------------------------------------------------
  // RIEPILOGO
  // ----------------------------------------------------

  console.log('');
  console.log('====================================');
  console.log(`TRENO: ${train}`);
  console.log(`RIGHE LETTE: ${events.length}`);
  console.log(`EVENTI TROVATI: ${matches.length}`);
  console.log('====================================');

  for (const event of matches) {
    console.log(
      `${event.event_id} | ${event.event_name} | ${event.description}`
    );
  }

  console.log('JSON salvati nella cartella output.');

  // ----------------------------------------------------
  // SUPABASE OPZIONALE
  // ----------------------------------------------------

  if (
    String(process.env.SAVE_TO_SUPABASE).toLowerCase() === 'true'
  ) {
    if (
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_KEY
    ) {
      throw new Error('Configurazione Supabase incompleta.');
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: { persistSession: false }
      }
    );

    const payload = matches
      .filter(event => event.event_id)
      .map(event => ({
        source_event_id: event.event_id,
        vehicle: event.vehicle,
        train_number: event.train_number,
        composition: event.composition,
        coach: event.coach,
        subsystem: event.subsystem,
        processor: event.processor,
        error_code: event.error_code,
        priority: event.priority,
        event_name: event.event_name,
        description: event.description,
        start_at_raw: event.start_at_raw,
        end_at_raw: event.end_at_raw,
        duration_seconds: event.duration_seconds,
        position: event.position,
        speed_kmh: event.speed_kmh,
        status: 'Da validare',
        raw_data: event.raw_row
      }));

    if (payload.length) {
      const { error } = await supabase
        .from(
          process.env.SUPABASE_TABLE ||
          'telediagnostica_eventi'
        )
        .upsert(payload, {
          onConflict: 'vehicle,source_event_id',
          ignoreDuplicates: true
        });

      if (error) throw error;

      console.log(
        `Salvati ${payload.length} eventi su Supabase.`
      );
    }
  }

} catch (error) {
  console.error('');
  console.error('ERRORE DURANTE LA RICERCA:');
  console.error(error);

  await fs.mkdir('output', { recursive: true });

  await page.screenshot({
    path: `output/train-${train}-error.png`,
    fullPage: true
  }).catch(() => {});

  throw error;

} finally {
  await browser.close();
}
