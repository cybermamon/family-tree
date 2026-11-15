// Paste all of this into Supabase > Edge Functions > Deploy a new function > Via Editor, named: tree
// @ts-nocheck
// Family tree access rules, shared by the Supabase Edge Function (and its tests).
// A member is linked to one person in the tree. They see:
//   their blood family (everyone descended from any of their ancestors) and those people's spouses,
//   the blood family of their own spouse(s) and those people's spouses,
//   and for every other spouse in those families: that spouse's ancestors, descendants, brothers and sisters.
// So you see your brother's wife's parents, grandparents and siblings, but not her cousins or her siblings' in-laws.

function parseGraph(text, pfx, P, F) {
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d+)\s+(@[^@]+@\s+)?(\S+)(?:\s(.*))?$/); if (!m) continue;
    const lv = +m[1], xref = m[2] && m[2].trim(), tag = m[3], val = (m[4] || '').trim();
    if (lv === 0) {
      cur = null;
      if (xref && tag === 'INDI') cur = P[pfx + xref] = { id: pfx + xref, name: '', t: 'I' };
      else if (xref && tag === 'FAM') cur = F[pfx + xref] = { id: pfx + xref, husb: null, wife: null, chil: [], t: 'F' };
      continue;
    }
    if (!cur || lv !== 1) continue;
    if (cur.t === 'I') { if (tag === 'NAME' && !cur.name) cur.name = val; }
    else if (tag === 'HUSB') cur.husb = pfx + val;
    else if (tag === 'WIFE') cur.wife = pfx + val;
    else if (tag === 'CHIL') cur.chil.push(pfx + val);
  }
}
const niceName = n => (n || 'Unknown').replace(/\//g, '').replace(/\s+/g, ' ').trim() || 'Unknown';

// Same rules as rebuild() in viewer/template.html
function buildGraph(sources, links, ovP, ovF) {
  const P = {}, F = {};
  sources.forEach(s => parseGraph(s.ged, s.prefix + ':', P, F));
  (links || []).forEach((l, i) => {
    const find = n => Object.values(P).find(p => niceName(p.name).toLowerCase() === String(n).toLowerCase());
    const h = find(l.husb), w = find(l.wife); if (!h || !w) return;
    const id = 'L:@F' + i + '@'; F[id] = { id, husb: h.id, wife: w.id, chil: [], t: 'F' };
  });
  for (const id in ovF) { const o = ovF[id]; if (o.deleted) { delete F[id]; continue }
    F[id] = { id, husb: o.husb || null, wife: o.wife || null, chil: (o.chil || []).slice(), t: 'F' } }
  for (const id in ovP) { const o = ovP[id]; if (o.deleted) { delete P[id]; continue }
    P[id] = P[id] || { id, t: 'I' }; P[id].name = o.name || '' }
  for (const id in P) { P[id].famc = []; P[id].fams = [] }
  Object.values(F).forEach(f => {
    if (f.husb && !P[f.husb]) f.husb = null; if (f.wife && !P[f.wife]) f.wife = null; f.chil = f.chil.filter(c => P[c]);
    [f.husb, f.wife].forEach(x => x && P[x].fams.push(f.id)); f.chil.forEach(c => P[c].famc.push(f.id));
  });
  return { P, F };
}

function helpers(G) {
  const { P, F } = G;
  const parents = id => (P[id] ? P[id].famc : []).flatMap(f => [F[f].husb, F[f].wife]).filter(Boolean);
  const spouses = id => (P[id] ? P[id].fams : []).map(f => F[f].husb === id ? F[f].wife : F[f].husb).filter(Boolean);
  const children = id => (P[id] ? P[id].fams : []).flatMap(f => F[f].chil);
  const ancestors = id => { const s = new Set(), st = [id]; while (st.length) { const x = st.pop(); if (s.has(x)) continue; s.add(x); st.push(...parents(x)) } return s };
  const descendants = ids => { const s = new Set(), st = [...ids]; while (st.length) { const x = st.pop(); if (s.has(x)) continue; s.add(x); st.push(...children(x)) } return s };
  return { parents, spouses, children, ancestors, descendants };
}

function visibleSet(G, me) {
  const V = new Set(); if (!me || !G.P[me]) return V;
  const h = helpers(G); const inlaws = new Set();
  const family = root => { const blood = h.descendants(h.ancestors(root)); blood.forEach(x => { V.add(x); h.spouses(x).forEach(s => { V.add(s); if (!blood.has(s)) inlaws.add(s) }) }) };
  family(me); h.spouses(me).forEach(s => { inlaws.delete(s); family(s) });
  h.spouses(me).forEach(s => inlaws.delete(s));
  // a relative's spouse: also their ancestors, descendants, parents and brothers and sisters
  inlaws.forEach(s => { h.ancestors(s).forEach(x => V.add(x)); h.descendants([s]).forEach(x => V.add(x));
    h.parents(s).forEach(p => h.children(p).forEach(x => V.add(x))) });
  return V;
}

// Family admins: own ancestors and descendants, plus anyone closer to them than to any other family admin.
function familyAdminScope(G, me, others) {
  const S = new Set(); if (!me || !G.P[me]) return S;
  const h = helpers(G);
  const nb = id => [...h.parents(id), ...h.spouses(id), ...h.children(id)];
  const bfs = starts => { const d = {}; const q = starts.filter(x => G.P[x]); q.forEach(x => d[x] = 0);
    for (let i = 0; i < q.length; i++) { const x = q[i]; for (const y of nb(x)) if (!(y in d)) { d[y] = d[x] + 1; q.push(y) } } return d };
  const dMe = bfs([me]), dOt = bfs((others || []).filter(x => x !== me));
  h.ancestors(me).forEach(x => S.add(x)); h.descendants([me]).forEach(x => S.add(x));
  for (const id in dMe) if (!(id in dOt) || dMe[id] <= dOt[id]) S.add(id);
  return S;
}

// Keep only the visible people (and the family links between them) in a research GEDCOM.
function filterGed(text, pfx, V) {
  const out = []; let keep = true, isFam = false;
  const lines = text.split(/\r?\n/);
  // which FAM records have at least one visible member
  const famOk = {}; let curFam = null;
  for (const raw of lines) { const m = raw.match(/^\s*(\d+)\s+(@[^@]+@\s+)?(\S+)(?:\s(.*))?$/); if (!m) continue;
    if (m[1] === '0') curFam = m[2] && m[3] === 'FAM' ? pfx + m[2].trim() : null;
    else if (curFam && m[1] === '1' && /^(HUSB|WIFE|CHIL)$/.test(m[3]) && V.has(pfx + (m[4] || '').trim())) famOk[curFam] = true }
  for (const raw of lines) {
    const m = raw.match(/^\s*(\d+)\s+(@[^@]+@\s+)?(\S+)(?:\s(.*))?$/); if (!m) continue;
    const lv = m[1], xref = m[2] && m[2].trim(), tag = m[3], val = (m[4] || '').trim();
    if (lv === '0') {
      isFam = tag === 'FAM';
      keep = (!xref && (tag === 'HEAD' || tag === 'TRLR')) || (xref && tag === 'INDI' && V.has(pfx + xref)) || (xref && isFam && famOk[pfx + xref]);
      if (tag === 'HEAD') keep = true;
    }
    if (!keep) continue;
    if (lv === '1' && isFam && /^(HUSB|WIFE|CHIL)$/.test(tag) && !V.has(pfx + val)) { keep = 'skipsub'; continue }
    if (keep === 'skipsub') { if (+lv > 1) continue; keep = true }
    if (lv === '1' && /^(FAMC|FAMS)$/.test(tag) && !famOk[pfx + val]) { keep = 'skipsub'; continue }
    out.push(raw);
  }
  return out.join('\n');
}

// What a member receives. docs = {people:{docId:data}, families:{...}, media:{...}}
function viewFor(member, research, docs, admins) {
  const cfgRow = research.find(r => r.prefix === '_config'); const cfg = cfgRow ? JSON.parse(cfgRow.ged) : {};
  const sources = research.filter(r => r.prefix !== '_config');
  const byId = coll => { const o = {}; Object.values(docs[coll] || {}).forEach(v => { if (v && v.id) o[v.id] = v }); return o };
  const G = buildGraph(sources, cfg.links, byId('people'), byId('families'));
  const V = visibleSet(G, member.person);
  let E;
  if (member.role === 'editor') { // their own line: ancestors, descendants, and the spouses of all of them
    const h = helpers(G), line = new Set([...h.ancestors(member.person), ...h.descendants([member.person])]);
    E = new Set(); if (G.P[member.person]) line.forEach(x => { E.add(x); h.spouses(x).forEach(sp => E.add(sp)) });
    E = new Set([...E].filter(x => V.has(x))) }
  else if (member.role === 'family_admin') { const S = familyAdminScope(G, member.person, admins); E = new Set([...S].filter(x => V.has(x))) }
  else E = new Set();
  const out = { people: [], families: [], media: [] };
  for (const [k, v] of Object.entries(docs.people || {})) if (v && V.has(v.id)) out.people.push([k, v]);
  for (const [k, v] of Object.entries(docs.families || {})) {
    if (!v) continue;
    if (v.deleted) { out.families.push([k, { id: v.id, deleted: true }]); continue }
    const mem = [v.husb, v.wife, ...(v.chil || [])].filter(Boolean);
    if (!mem.some(x => V.has(x))) continue;
    out.families.push([k, Object.assign({}, v, { husb: V.has(v.husb) ? v.husb : null, wife: V.has(v.wife) ? v.wife : null, chil: (v.chil || []).filter(x => V.has(x)) })]);
  }
  for (const [k, v] of Object.entries(docs.media || {})) if (v && V.has(v.person)) out.media.push([k, v]);
  return {
    sources: sources.map(s => ({ prefix: s.prefix, label: s.label, updated_at: s.updated_at, ged: filterGed(s.ged, s.prefix + ':', V) })),
    cfg: { links: (cfg.links || []), home: cfg.home, built: cfg.built, order: cfg.order },
    homeId: member.person && V.has(member.person) ? member.person : null,
    docs: out, editable: [...E], G, V, E,
  };
}

// May this member make these writes? (Family rows are completed in place.) rows = [{coll,id,data}] or deletes [{coll,id,del:true}]
function checkWrites(member, view, current, rows) {
  if (member.role === 'admin') return null;
  if (!['editor', 'family_admin'].includes(member.role)) return 'Your account can only view the tree.';
  const { G, V, E } = view;
  const isNew = id => typeof id === 'string' && id.startsWith('N:') && !G.P[id];
  const ok = id => E.has(id) || isNew(id);
  for (const r of rows) {
    const d = r.del ? (current[r.coll] || {})[r.id] : r.data;
    if (!d) continue;
    if (r.coll === 'people') { if (!ok(d.id)) return 'You can’t change ' + niceName((G.P[d.id] || {}).name) + '.' }
    else if (r.coll === 'media') { const old = (current.media || {})[r.id]; if (!ok(d.person) || (old && !ok(old.person))) return 'You can’t change files for that person.' }
    else if (r.coll === 'families') {
      const old = G.F[d.id] || {};
      if (!r.del && !d.deleted) { // put back the members this person can't see, so saving doesn't drop them
        if (!d.husb && old.husb && !V.has(old.husb)) d.husb = old.husb;
        if (!d.wife && old.wife && !V.has(old.wife)) d.wife = old.wife;
        d.chil = (d.chil || []).concat((old.chil || []).filter(x => !V.has(x) && !(d.chil || []).includes(x)));
      }
      const mine = [d.husb, d.wife, ...(d.chil || [])].filter(Boolean).filter(x => V.has(x) || isNew(x));
      const all = [d.husb, d.wife, ...(d.chil || []), old.husb, old.wife, ...(old.chil || [])].filter(Boolean);
      if (all.some(x => !V.has(x) && !isNew(x) && !(G.P[x]))) return 'Unknown person in that family.';
      if (!mine.concat([old.husb, old.wife, ...(old.chil || [])].filter(x => x && V.has(x))).some(ok)) return 'You can’t change that family.';
    } else return 'Unknown change.';
  }
  return null;
}


// ---------- Supabase Edge Function "tree" ----------
// Members (except admins) read the tree and save their changes only through this function.
import { createClient } from 'npm:@supabase/supabase-js@2';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
let SECRET = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
try { const ks = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); SECRET = SECRET || ks.default || Object.values(ks)[0] || '' } catch (_) { /* older projects */ }
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function all(sb: any, table: string, cols: string) {
  const out: any[] = [];
  for (let i = 0; ; i += 1000) { const { data, error } = await sb.from(table).select(cols).range(i, i + 999); if (error) throw error; out.push(...data); if (data.length < 1000) return out }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const sb = createClient(SB_URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u, error: ue } = await sb.auth.getUser(token);
    if (ue || !u || !u.user) return json({ error: 'Please sign in again.' }, 401);
    const uid = u.user.id;
    const { data: member } = await sb.from('members').select('role,person').eq('user_id', uid).maybeSingle();
    if (!member || !['viewer', 'editor', 'family_admin', 'admin'].includes(member.role)) return json({ error: 'Your account has no access yet.' }, 403);
    const body = await req.json().catch(() => ({}));

    const [research, rows, members] = await Promise.all([
      all(sb, 'research', 'prefix,label,ged,updated_at'), all(sb, 'docs', 'coll,id,data'),
      all(sb, 'members', 'user_id,email,name,person,role,created_at'),
    ]);
    const admins = members.filter((x: any) => x.person && ['family_admin', 'admin'].includes(x.role)).map((x: any) => x.person);
    const docs: any = { people: {}, families: {}, media: {} };
    rows.forEach((r: any) => { (docs[r.coll] = docs[r.coll] || {})[r.id] = r.data });
    const view: any = viewFor(member, research, docs, admins);

    if (body.op === 'createUser') { // admins (and family admins, for their own family) create an account for someone in the tree
      const fa = member.role === 'family_admin';
      if (member.role !== 'admin' && !fa) return json({ error: 'Only admins and family admins can create accounts.' }, 403);
      if (fa && !view.E.has(body.person)) return json({ error: 'You can only create accounts for your own family.' }, 403);
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
      if (String(body.password || '').length < 8) return json({ error: 'The password needs at least 8 characters.' }, 400);
      if (!(fa ? ['viewer', 'editor'] : ['viewer', 'editor', 'family_admin', 'admin']).includes(body.role)) return json({ error: 'Pick a role.' }, 400);
      const { data: cu, error: ce } = await sb.auth.admin.createUser({ email, password: body.password, email_confirm: true,
        user_metadata: { name: body.name || '', must_change_password: true } });
      if (ce || !cu || !cu.user) return json({ error: /already/i.test(ce?.message || '') ? 'That email already has an account.' : (ce?.message || 'Could not create the account.') }, 400);
      const { error: me2 } = await sb.from('members').update({ role: body.role, person: body.person || null, name: body.name || '' }).eq('user_id', cu.user.id);
      if (me2) return json({ error: 'Account created, but setting its role failed: ' + me2.message }, 500);
      return json({ ok: true, login: email });
    }
    if (body.op === 'pending') { // family admins see who is waiting, to approve their own relatives
      if (!['family_admin', 'admin'].includes(member.role)) return json({ error: 'Not allowed.' }, 403);
      return json({ pending: members.filter((m: any) => m.role === 'pending').map((m: any) => ({ user_id: m.user_id, name: m.name, email: m.email, created_at: m.created_at })) });
    }
    if (body.op === 'approve') {
      if (!['family_admin', 'admin'].includes(member.role)) return json({ error: 'Not allowed.' }, 403);
      const target = members.find((m: any) => m.user_id === body.user_id);
      if (!target || target.role !== 'pending') return json({ error: 'That sign-up is no longer waiting.' }, 400);
      if (!['viewer', 'editor'].includes(body.role)) return json({ error: 'Pick a role.' }, 400);
      if (member.role === 'family_admin' && !view.E.has(body.person)) return json({ error: 'Pick someone in your own family.' }, 403);
      const { error } = await sb.from('members').update({ role: body.role, person: body.person }).eq('user_id', body.user_id).eq('role', 'pending');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (body.op === 'write') {
      const seen = new Map(); for (const w of (body.rows || [])) seen.set(w.coll + '|' + w.id, w);
      const ws = [...seen.values()].map((w: any) => w.del ? { coll: w.coll, id: w.id, del: true } : { coll: w.coll, id: w.id, data: w.data });
      const err = checkWrites(member, view, docs, ws);
      if (err) return json({ error: err }, 403);
      const { error } = await sb.rpc('docs_write_as', { p_user: uid, p_upserts: ws.filter((w: any) => !w.del), p_deletes: ws.filter((w: any) => w.del) });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // read: sign the photo links for the files this member may see
    const media = view.docs.media; const paths = [...new Set(media.map(([, v]: any) => v.asset).filter(Boolean))] as string[];
    const urls: Record<string, string> = {};
    for (let i = 0; i < paths.length; i += 500) {
      const { data } = await sb.storage.from('media').createSignedUrls(paths.slice(i, i + 500), 7 * 86400);
      (data || []).forEach((d: any) => { if (d.signedUrl && d.path) urls[d.path] = d.signedUrl });
    }
    media.forEach(([, v]: any) => { if (urls[v.asset]) v.url = urls[v.asset] });
    return json({ sources: view.sources, cfg: view.cfg, homeId: view.homeId, docs: view.docs, editable: view.editable });
  } catch (e) {
    return json({ error: String((e && (e as any).message) || e) }, 500);
  }
});
