import { useState } from "react";
import { api, fmt, Modal } from "../lib.tsx";
import type { Trade } from "./Dashboard.tsx";

type Meta = { custom?: boolean; dir?: 1 | -1; uStop?: number | null; curStop?: number | null; uTarget?: number | null; manualIdxStop?: number | null; premStop?: number | null };

/** SL / TGT cell for an open position, with ✎ edit. Builder trades: the real stop is on the index (trails), plus an optional premium SL. */
export function StopCell({ t, onSaved }: { t: Trade; onSaved?: () => void }) {
  const m = ((t as { meta?: Meta }).meta ?? {}) as Meta;
  const [edit, setEdit] = useState(false);
  const L = t.side === "LONG", idxStop = m.curStop ?? m.uStop ?? null;
  const tgt = m.custom && !m.uTarget ? "— (exit rule)" : fmt(m.custom ? m.uTarget : t.targetPrice);
  return <>
    {m.custom ? <span className="num" style={{ display: "inline-grid", gap: 2, textAlign: "right", fontSize: 13 }}>
      <span className="down" title={`${t.underlying} spot index par stop · shuru ka SL ${m.uStop != null ? fmt(m.uStop) : "—"}`}>{t.underlying} {m.dir === -1 ? "≥" : "≤"} {idxStop != null ? fmt(idxStop) : "—"}{idxStop != null && m.uStop != null && idxStop !== m.uStop ? " ↑" : ""}</span>
      {m.premStop != null && <span className="down" style={{ fontSize: 12 }}>Prem {L ? "≤" : "≥"} {fmt(m.premStop)}</span>}
      <span className="up" style={{ fontSize: 12 }}>TGT {tgt}</span>
    </span>
      : <span className="num"><span className="down">{fmt(t.stopPrice)}</span> / <span className="up">{tgt}</span></span>}
    {" "}<button className="btn sm" style={{ verticalAlign: "top" }} title="Stop loss edit karein" onClick={() => setEdit(true)}>✎</button>
    {edit && <EditStop t={t} m={m} idxStop={idxStop} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); onSaved?.(); }} />}
  </>;
}

function EditStop({ t, m, idxStop, onClose, onSaved }: { t: Trade; m: Meta; idxStop: number | null; onClose: () => void; onSaved: () => void }) {
  const L = t.side === "LONG";
  const [prem, setPrem] = useState(m.custom ? (m.premStop != null ? String(m.premStop) : "") : String(Number(t.stopPrice)));
  const [idx, setIdx] = useState(m.manualIdxStop != null ? String(m.manualIdxStop) : "");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const save = async (body: object) => { setErr(""); setBusy(true); try { await api(`/api/positions/${t.id}/stop`, { json: body }); onSaved(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return <Modal title={`✎ Stop loss — ${t.contract}`} onClose={onClose}>
    <div style={{ display: "grid", gap: 12, textAlign: "left", whiteSpace: "normal" }}>
      <div className="muted" style={{ fontSize: 13 }}>Entry {fmt(t.entryPrice)} · LTP {fmt(t.lastPrice)} · {L ? "LONG" : "SHORT"} · price SL par ya {L ? "neeche" : "upar"} aate hi trade band hoga (har tick check).</div>
      {m.custom && <div className="note">Is strategy ka asli stop <b>{t.underlying} index</b> par hai: abhi <b>{idxStop != null ? fmt(idxStop) : "—"}</b>. Ye har naye swing pivot ke saath apne aap <b>{m.dir === -1 ? "neeche" : "upar"}</b> trail hota hai (kabhi peeche nahi jata).</div>}
      <label className="field"><span>{m.custom ? "Premium SL (option price ₹) — optional" : "Stop loss (contract price ₹)"}</span>
        <input className="input num" type="number" step="0.05" value={prem} placeholder={m.custom ? "e.g. " + fmt(Number(t.lastPrice) * 0.8) : ""} onChange={e => setPrem(e.target.value)} /></label>
      {m.custom && <label className="field"><span>{t.underlying} index SL — optional (sirf tight kar sakta hai; trail isse aage badhta rahega)</span>
        <input className="input num" type="number" step="0.05" value={idx} placeholder={idxStop != null ? fmt(idxStop) : ""} onChange={e => setIdx(e.target.value)} /></label>}
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy} onClick={() => save(m.custom ? { premiumStop: prem.trim() || null, indexStop: idx.trim() || null } : { premiumStop: prem })}>✓ Save SL</button>
        {m.custom && (m.premStop != null || m.manualIdxStop != null) && <button className="btn" disabled={busy} onClick={() => save({ premiumStop: null, indexStop: null })}>Manual SL hatao</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  </Modal>;
}
