import { useState, useEffect, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { supabase } from "./supabase.js";

// ── helpers ───────────────────────────────────────────────────────────────────
const stLbsToKg = (st, lbs) => +((st * 14 + lbs) * 0.453592).toFixed(1);
const kgToStLbs = (kg) => {
  const totalLbs = kg / 0.453592;
  const st = Math.floor(totalLbs / 14);
  const lbs = +((totalLbs % 14).toFixed(1));
  return { st, lbs };
};
const localISO = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const parseLocalDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const formatDate = (iso) =>
  parseLocalDate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });

// ── seed data ─────────────────────────────────────────────────────────────────
const mkW = (date, st, lbs) => ({ date, st, lbs, kg: stLbsToKg(st, lbs) });
const SEED_WEIGHTS = [
  mkW("2026-04-10",15,2.6), mkW("2026-04-11",15,1.7), mkW("2026-04-12",15,1.2),
  mkW("2026-04-14",15,0.6), mkW("2026-04-15",15,0.2), mkW("2026-04-17",15,0.5),
  mkW("2026-04-18",15,0.8), mkW("2026-04-22",14,11.5),mkW("2026-04-24",14,12.1),
  mkW("2026-04-25",14,9.9), mkW("2026-04-27",14,10.9),mkW("2026-04-28",14,10.5),
  mkW("2026-04-29",14,10.0),mkW("2026-04-30",14,9.0), mkW("2026-05-01",14,8.9),
  mkW("2026-05-06",14,8.5), mkW("2026-05-07",14,7.5), mkW("2026-05-08",14,6.5),
  mkW("2026-05-11",14,6.4), mkW("2026-05-12",14,5.4),
];

// ── regression + chart ────────────────────────────────────────────────────────
const linearRegression = (pts) => {
  const n = pts.length;
  if (n < 2) return null;
  const sx = pts.reduce((a,p)=>a+p.x,0), sy = pts.reduce((a,p)=>a+p.y,0);
  const sxy = pts.reduce((a,p)=>a+p.x*p.y,0), sx2 = pts.reduce((a,p)=>a+p.x*p.x,0);
  const denom = n*sx2 - sx*sx;
  if (denom===0) return null;
  const slope = (n*sxy - sx*sy) / denom;
  return { slope, intercept: (sy - slope*sx) / n };
};

const buildChartData = (entries, yKey, projectionMonths = 6, lookbackDays = 60) => {
  if (!entries.length) return [];
  const sorted = [...entries].sort((a,b)=>parseLocalDate(a.date)-parseLocalDate(b.date));
  const DAY = 86400000;
  const lastD = parseLocalDate(sorted[sorted.length-1].date);
  const cutoff = new Date(lastD.getTime() - 60 * DAY);
  const recentEntries = sorted.filter(e => parseLocalDate(e.date) >= cutoff);
  const trendEntries = recentEntries.length >= 2 ? recentEntries : sorted;
  const t0trend = parseLocalDate(trendEntries[0].date).getTime();
  const toDaysTrend = (iso) => (parseLocalDate(iso).getTime() - t0trend) / DAY;
  const reg = linearRegression(trendEntries.map(e=>({x:toDaysTrend(e.date),y:e[yKey]})));
  const today = new Date();
  const chartStart = new Date(today.getTime() - lookbackDays * DAY);
  const endD = new Date(lastD.getFullYear(), lastD.getMonth() + projectionMonths, lastD.getDate());
  const actualMap = Object.fromEntries(sorted.map(e=>[e.date,e[yKey]]));
  const rows = [];
  const cursor = new Date(chartStart);
  while (cursor <= endD) {
    const iso = localISO(cursor);
    const xd = toDaysTrend(iso);
    rows.push({ date:iso, actual:actualMap[iso]??null, trend:reg?+(reg.slope*xd+reg.intercept).toFixed(2):null });
    cursor.setDate(cursor.getDate()+1);
  }
  return rows;
};

// ── stats helpers ─────────────────────────────────────────────────────────────
const calcWeightStats = (entries, targetKg) => {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a,b)=>parseLocalDate(a.date)-parseLocalDate(b.date));
  const DAY = 86400000;
  const latest = sorted[sorted.length-1];
  const first  = sorted[0];
  const totalLost = first.kg - latest.kg;

  // This month
  const now = new Date();
  const monthStart = localISO(new Date(now.getFullYear(), now.getMonth(), 1));
  const thisMonthEntries = sorted.filter(e=>e.date>=monthStart);
  const monthChange = thisMonthEntries.length >= 2
    ? thisMonthEntries[0].kg - thisMonthEntries[thisMonthEntries.length-1].kg
    : thisMonthEntries.length === 1 ? sorted[sorted.length-2]?.kg - latest.kg : 0;

  // Streak — consecutive days with an entry up to today
  let streak = 0;
  const cursor = new Date();
  while (true) {
    if (sorted.find(e=>e.date===localISO(cursor))) { streak++; cursor.setDate(cursor.getDate()-1); }
    else break;
    if (streak > 365) break;
  }

  // Weekly rate from trend (last 60 days)
  const cutoff = new Date(parseLocalDate(latest.date).getTime() - 60*DAY);
  const recent = sorted.filter(e=>parseLocalDate(e.date)>=cutoff);
  let weeklyRate = null;
  if (recent.length >= 2) {
    const reg = linearRegression(recent.map((e,i)=>({x:i,y:e.kg})));
    if (reg) weeklyRate = -(reg.slope * 7);
  }

  // PB (lowest weight)
  const pb = sorted.reduce((a,e)=>e.kg<a.kg?e:a, sorted[0]);

  // Estimated date to reach target
  let targetDate = null;
  if (targetKg && weeklyRate > 0 && latest.kg > targetKg) {
    const weeksNeeded = (latest.kg - targetKg) / weeklyRate;
    const d = new Date();
    d.setDate(d.getDate() + Math.round(weeksNeeded * 7));
    targetDate = formatDate(localISO(d));
  }

  return { latest, totalLost, monthChange, streak, weeklyRate, pb, targetDate };
};

const calcHba1cStats = (entries) => {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a,b)=>parseLocalDate(a.date)-parseLocalDate(b.date));
  const latest = sorted[sorted.length-1];
  const prev   = sorted[sorted.length-2];
  const change = prev ? latest.score - prev.score : null;
  const best   = sorted.reduce((a,e)=>e.score<a.score?e:a, sorted[0]);
  return { latest, change, best };
};

// ── tooltips ──────────────────────────────────────────────────────────────────
const ttStyle = { background:"#1e2433", border:"1px solid rgba(255,255,255,0.12)", borderRadius:10, padding:"0.75rem 1rem", fontSize:"0.82rem" };
const ttLbl   = { color:"#9ca3af", marginBottom:"0.35rem", fontWeight:600 };

const WeightTooltip = ({ active, payload, label }) => {
  if (!active||!payload?.length) return null;
  return <div style={ttStyle}><p style={ttLbl}>{formatDate(label)}</p>{payload.map(p=>{if(p.value==null)return null;const{st,lbs}=kgToStLbs(p.value);return<p key={p.dataKey} style={{color:p.color}}>{p.dataKey==="actual"?"Actual":"Trend"}: {st}st {lbs}lbs ({p.value} kg)</p>;})}</div>;
};
const HbA1cTooltip = ({ active, payload, label }) => {
  if (!active||!payload?.length) return null;
  return <div style={ttStyle}><p style={ttLbl}>{formatDate(label)}</p>{payload.map(p=>p.value!=null&&<p key={p.dataKey} style={{color:p.color}}>{p.dataKey==="actual"?"Actual":"Trend"}: {p.value} mmol/mol</p>)}</div>;
};

// ── dashboard ─────────────────────────────────────────────────────────────────
function WeightDashboard({ entries, targetKg }) {
  const stats = useMemo(()=>calcWeightStats(entries, targetKg),[entries,targetKg]);
  if (!stats) return null;
  const { latest, totalLost, monthChange, streak, weeklyRate, pb, targetDate } = stats;
  const { st, lbs } = kgToStLbs(latest.kg);
  const { st:pbSt, lbs:pbLbs } = kgToStLbs(pb.kg);
  const cards = [
    { label:"Current Weight", value:`${st}st ${lbs}lbs`, sub:`${latest.kg} kg`, color:"#34d399" },
    
    { label:"This Month", value:(()=>{ const v=Math.abs(monthChange); const {st,lbs}=kgToStLbs(v); const sign=monthChange>=0?"-":"+"; return v<6.35?`${sign} ${(v/0.453592).toFixed(1)}lbs`:`${sign} ${st}st ${lbs}lbs`; })(), sub:monthChange>0?"lost this month":monthChange<0?"gained this month":"no change", color: monthChange>=0?"#34d399":"#ef4444" },

    { label:"Personal Best", value:`${pbSt}st ${pbLbs}lbs`, sub:formatDate(pb.date), color:"#f472b6" },
    

  ];
  return (
    <div className="dashboard">
      {cards.map(c=>(
        <div key={c.label} className="dash-card">
          <div className="dash-label">{c.label}</div>
          <div className="dash-value" style={{color:c.color}}>{c.value}</div>
          {c.sub && <div className="dash-sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function HbA1cDashboard({ entries }) {
  const stats = useMemo(()=>calcHba1cStats(entries),[entries]);
  if (!stats) return null;
  const { latest, change, best } = stats;
  const classify = s => s>=48?"Diabetic":s>=42?"Pre-diabetic":"Normal";
  const classColor = s => s>=48?"#ef4444":s>=42?"#fb923c":"#34d399";
  const cards = [
    { label:"Latest HbA1c", value:`${latest.score} mmol/mol`, sub:classify(latest.score), color:classColor(latest.score) },
    { label:"Change", value:change!=null?`${change>0?"+":""}${change.toFixed(1)} mmol/mol`:"—", sub:change!=null?(change<0?"improving ✓":change>0?"rising":"no change"):"", color:change!=null?(change<0?"#34d399":change>0?"#ef4444":"#9ca3af"):"#9ca3af" },
    { label:"Personal Best", value:`${best.score} mmol/mol`, sub:formatDate(best.date), color:"#f472b6" },
    { label:"Total Readings", value:String(entries.length), sub:"recorded", color:"#38bdf8" },
  ];
  return (
    <div className="dashboard">
      {cards.map(c=>(
        <div key={c.label} className="dash-card">
          <div className="dash-label">{c.label}</div>
          <div className="dash-value" style={{color:c.color}}>{c.value}</div>
          {c.sub && <div className="dash-sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ── monthly summary ───────────────────────────────────────────────────────────
function MonthlyTable({ entries, yKey, formatVal }) {
  const months = useMemo(() => {
    if (!entries.length) return [];
    const byMonth = {};
    entries.forEach(e => {
      const key = e.date.slice(0,7);
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push(e[yKey]);
    });
    return Object.entries(byMonth).sort((a,b)=>b[0].localeCompare(a[0])).map(([key,vals])=>({
      month: parseLocalDate(key+"-01").toLocaleDateString("en-GB",{month:"long",year:"numeric"}),
      avg: vals.reduce((a,v)=>a+v,0)/vals.length,
      min: Math.min(...vals),
      max: Math.max(...vals),
      count: vals.length,
    }));
  },[entries,yKey]);
  if (!months.length) return null;
  return (
    <div className="list-table">
      <table>
        <thead><tr><th>Month</th><th>Avg</th><th>Best</th><th>Worst</th><th>Entries</th></tr></thead>
        <tbody>{months.map((m,i)=>(
          <tr key={i}>
            <td>{m.month}</td>
            <td>{formatVal(m.avg)}</td>
            <td style={{color:"#34d399"}}>{formatVal(m.min)}</td>
            <td style={{color:"#f87171"}}>{formatVal(m.max)}</td>
            <td style={{color:"#6b7280"}}>{m.count}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ── target weight setter ──────────────────────────────────────────────────────
function TargetSetter({ targetKg, onSave }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState("");
  const [lbs, setLbs] = useState("");
  useEffect(()=>{
    if (targetKg) { const {st,lbs}=kgToStLbs(targetKg); setSt(String(st)); setLbs(String(lbs)); }
  },[targetKg]);
  const kg = (st||lbs) ? stLbsToKg(Number(st)||0,Number(lbs)||0) : null;
  const handleSave = () => { if(kg) { onSave(kg); setOpen(false); } };
  const handleClear = () => { onSave(null); setSt(""); setLbs(""); setOpen(false); };
  if (!open) {
    const {st:ts,lbs:tl} = targetKg ? kgToStLbs(targetKg) : {};
    return (
      <button className="target-btn" onClick={()=>setOpen(true)}>
        🎯 {targetKg ? `Target: ${ts}st ${tl}lbs` : "Set target weight"}
      </button>
    );
  }
  return (
    <div className="input-card">
      <h3>Target Weight</h3>
      <div className="input-row">
        <div className="input-group"><label>Stone</label><input type="number" min="0" max="40" value={st} onChange={e=>setSt(e.target.value)} /></div>
        <div className="input-group"><label>Lbs</label><input type="number" min="0" max="13" step="0.1" value={lbs} onChange={e=>setLbs(e.target.value)} /></div>
        <div className="input-group kg-display"><label>Kilograms</label><div className="kg-value">{kg?`${kg.toFixed(1)} kg`:"—"}</div></div>
        <button className="add-btn" onClick={handleSave}>Save</button>
        {targetKg && <button className="cancel-btn" onClick={handleClear}>Clear</button>}
        <button className="cancel-btn" onClick={()=>setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// ── export CSV ────────────────────────────────────────────────────────────────
const exportCSV = (entries, filename, headers, row) => {
  const lines = [headers.join(","), ...entries.map(row)];
  const blob = new Blob([lines.join("\n")], {type:"text/csv"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename; a.click();
};

// ── edit modals ───────────────────────────────────────────────────────────────
function WeightEditModal({ entry, onSave, onClose }) {
  const [st,setSt]=useState(String(entry.st));
  const [lbs,setLbs]=useState(String(entry.lbs));
  const [date,setDate]=useState(entry.date);
  const [note,setNote]=useState(entry.note||"");
  const kg = stLbsToKg(Number(st)||0, Number(lbs)||0);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><h3>Edit Weight Entry</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="input-row">
          <div className="input-group"><label>Stone</label><input type="number" min="0" max="40" value={st} onChange={e=>setSt(e.target.value)} /></div>
          <div className="input-group"><label>Lbs</label><input type="number" min="0" max="13" step="0.1" value={lbs} onChange={e=>setLbs(e.target.value)} /></div>
          <div className="input-group kg-display"><label>Kilograms</label><div className="kg-value">{kg.toFixed(1)} kg</div></div>
          <div className="input-group"><label>Date</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} /></div>
        </div>
        <div className="input-group" style={{width:"100%"}}>
          <label>Note (optional)</label>
          <input type="text" value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. started medication, holiday week…" style={{width:"100%"}} />
        </div>
        <div className="modal-actions">
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
          <button className="add-btn" onClick={()=>onSave({date,st:Number(st)||0,lbs:Number(lbs)||0,kg,note})}>Save</button>
        </div>
      </div>
    </div>
  );
}

function HbA1cEditModal({ entry, onSave, onClose }) {
  const [score,setScore]=useState(String(entry.score));
  const [date,setDate]=useState(entry.date);
  const [note,setNote]=useState(entry.note||"");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-header"><h3>Edit HbA1c Entry</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="input-row">
          <div className="input-group"><label>HbA1c (mmol/mol)</label><input type="number" min="20" max="200" step="0.1" value={score} onChange={e=>setScore(e.target.value)} /></div>
          <div className="input-group"><label>Date</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} /></div>
        </div>
        <div className="input-group" style={{width:"100%"}}>
          <label>Note (optional)</label>
          <input type="text" value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. fasted, post-illness…" style={{width:"100%"}} />
        </div>
        <div className="modal-actions">
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
          <button className="add-btn" onClick={()=>onSave({date,score:+Number(score).toFixed(1),note})}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── charts ────────────────────────────────────────────────────────────────────
function WeightChart({ entries, projectionMonths, lookbackDays, targetKg }) {
  const chartData = useMemo(()=>buildChartData(entries,"kg",projectionMonths,lookbackDays),[entries,projectionMonths,lookbackDays]);
  if (!entries.length) return <div className="empty-chart">No data yet.</div>;
  const yFmt = (kg)=>{const{st,lbs}=kgToStLbs(kg);return`${st}st ${Math.round(lbs)}lb`;};
  const ticks = chartData.filter((_,i)=>i%14===0).map(r=>r.date);
  const sorted = [...entries].sort((a,b)=>parseLocalDate(a.date)-parseLocalDate(b.date));
  const pb = sorted.reduce((a,e)=>e.kg<a.kg?e:a,sorted[0]);
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={chartData} margin={{top:10,right:15,left:0,bottom:20}}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
        <XAxis dataKey="date" ticks={ticks} tickFormatter={formatDate} tick={{fill:"#9ca3af",fontSize:11}} angle={-30} textAnchor="end" height={50} />
        <YAxis tickFormatter={yFmt} tick={{fill:"#9ca3af",fontSize:11}} width={72} domain={[63.5,"auto"]} />
        <Tooltip content={<WeightTooltip />} />
        <Legend wrapperStyle={{color:"#9ca3af",fontSize:12,paddingTop:8}} />
        <ReferenceLine x={localISO()} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" label={{value:"Today",fill:"#9ca3af",fontSize:10}} />
        <ReferenceLine x={pb.date} stroke="rgba(244,114,182,0.4)" strokeDasharray="3 3" label={{value:"PB",fill:"#f472b6",fontSize:10}} />
        {targetKg && <ReferenceLine y={targetKg} stroke="#a78bfa" strokeWidth={2} strokeDasharray="4 2" />}
        <Line type="monotone" dataKey="actual" name="Actual Weight" stroke="#34d399" strokeWidth={2} dot={p=>p.value!=null?<text key={p.key} x={p.cx} y={p.cy} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight="bold" fill="#34d399">✕</text>:null} activeDot={false} connectNulls />
        <Line type="monotone" dataKey="trend" name="Trend" stroke="#f59e0b" strokeWidth={1} strokeDasharray="6 3" dot={false} connectNulls opacity={0.5} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function HbA1cChart({ entries, projectionMonths, lookbackDays }) {
  const chartData = useMemo(()=>buildChartData(entries,"score",projectionMonths,lookbackDays),[entries,projectionMonths,lookbackDays]);
  if (!entries.length) return <div className="empty-chart">No data yet.</div>;
  const ticks = chartData.filter((_,i)=>i%14===0).map(r=>r.date);
  const sorted = [...entries].sort((a,b)=>parseLocalDate(a.date)-parseLocalDate(b.date));
  const pb = sorted.reduce((a,e)=>e.score<a.score?e:a,sorted[0]);
  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={chartData} margin={{top:10,right:30,left:10,bottom:20}}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" />
        <XAxis dataKey="date" ticks={ticks} tickFormatter={formatDate} tick={{fill:"#9ca3af",fontSize:11}} angle={-30} textAnchor="end" height={50} />
        <YAxis tick={{fill:"#9ca3af",fontSize:11}} unit=" mmol" />
        <Tooltip content={<HbA1cTooltip />} />
        <Legend wrapperStyle={{color:"#9ca3af",fontSize:12,paddingTop:8}} />
        <ReferenceLine y={48} stroke="rgba(239,68,68,0.4)" strokeDasharray="4 4" label={{value:"Diabetic (48)",fill:"#ef4444",fontSize:10,position:"insideTopLeft",offset:5}} />
        <ReferenceLine y={42} stroke="rgba(251,146,60,0.4)" strokeDasharray="4 4" label={{value:"Pre-diabetic (42)",fill:"#fb923c",fontSize:10,position:"insideBottomLeft",offset:5}} />
        <ReferenceLine x={pb.date} stroke="rgba(244,114,182,0.4)" strokeDasharray="3 3" label={{value:"PB",fill:"#f472b6",fontSize:10}} />
        <ReferenceLine x={localISO()} stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4" label={{value:"Today",fill:"#9ca3af",fontSize:10}} />
        <Line type="monotone" dataKey="actual" name="HbA1c" stroke="#818cf8" strokeWidth={2} dot={p=>p.value!=null?<text key={p.key} x={p.cx} y={p.cy} textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight="bold" fill="#818cf8">✕</text>:null} activeDot={false} connectNulls />
        <Line type="monotone" dataKey="trend" name="Trend" stroke="#f59e0b" strokeWidth={1} strokeDasharray="6 3" dot={false} connectNulls opacity={0.5} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── input forms ───────────────────────────────────────────────────────────────
function WeightInput({ onAdd }) {
  const [st,setSt]=useState(""), [lbs,setLbs]=useState(""), [date,setDate]=useState(localISO), [note,setNote]=useState("");
  const kg = (st!==""||lbs!=="") ? stLbsToKg(Number(st)||0,Number(lbs)||0) : null;
  const handleAdd = () => {
    if (st===""&&lbs==="") return;
    onAdd({date,st:Number(st)||0,lbs:Number(lbs)||0,kg:stLbsToKg(Number(st)||0,Number(lbs)||0),note});
    setSt(""); setLbs(""); setNote(""); setDate(localISO());
  };
  return (
    <div className="input-card">
      <h3>Log Weight</h3>
      <div className="input-row">
        <div className="input-group"><label>Stone</label><input type="number" min="0" max="40" value={st} onChange={e=>setSt(e.target.value)} placeholder="" /></div>
        <div className="input-group"><label>Lbs</label><input type="number" min="0" max="13" step="0.1" value={lbs} onChange={e=>setLbs(e.target.value)} placeholder="" /></div>
        <div className="input-group kg-display"><label>Kilograms</label><div className="kg-value">{kg!==null?`${kg.toFixed(1)} kg`:"—"}</div></div>
        <div className="input-group"><label>Date</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} /></div>
        <button className="add-btn" onClick={handleAdd}>Add</button>
      </div>
      <div className="input-group note-input">
        <label>Note (optional)</label>
        <input type="text" value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. started medication, holiday week…" />
      </div>
    </div>
  );
}

function HbA1cInput({ onAdd }) {
  const [score,setScore]=useState(""), [date,setDate]=useState(localISO), [note,setNote]=useState("");
  const handleAdd = () => { if(!score) return; onAdd({date,score:+Number(score).toFixed(1),note}); setScore(""); setNote(""); setDate(localISO()); };
  return (
    <div className="input-card">
      <h3>Log HbA1c</h3>
      <div className="input-row">
        <div className="input-group"><label>HbA1c (mmol/mol)</label><input type="number" min="20" max="200" step="0.1" value={score} onChange={e=>setScore(e.target.value)} placeholder="e.g. 53" /></div>
        <div className="input-group"><label>Date</label><input type="date" value={date} onChange={e=>setDate(e.target.value)} /></div>
        <button className="add-btn" onClick={handleAdd}>Add</button>
      </div>
      <div className="input-group note-input">
        <label>Note (optional)</label>
        <input type="text" value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. fasted, post-illness…" />
      </div>
    </div>
  );
}

// ── lists ─────────────────────────────────────────────────────────────────────
function WeightList({ entries, onDelete, onEdit }) {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a,b)=>parseLocalDate(b.date)-parseLocalDate(a.date));
  return (
    <div className="list-table"><table>
      <thead><tr><th>Date</th><th>Stone & Lbs</th><th>Kilograms</th><th>Note</th><th></th></tr></thead>
      <tbody>{sorted.map((e,i)=>(
        <tr key={e.id||i}>
          <td>{formatDate(e.date)}</td>
          <td>{e.st}st {e.lbs}lbs</td>
          <td>{e.kg} kg</td>
          <td style={{color:"#6b7280",fontSize:"0.8rem"}}>{e.note||""}</td>
          <td className="action-cell">
            <button className="edit-btn" onClick={()=>onEdit(e)}>✏</button>
            <button className="del-btn" onClick={()=>onDelete(e)}>✕</button>
          </td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function HbA1cList({ entries, onDelete, onEdit }) {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a,b)=>parseLocalDate(b.date)-parseLocalDate(a.date));
  const classify = s => s>=48?{label:"Diabetic",cls:"badge-red"}:s>=42?{label:"Pre-diabetic",cls:"badge-amber"}:{label:"Normal",cls:"badge-green"};
  return (
    <div className="list-table"><table>
      <thead><tr><th>Date</th><th>HbA1c (mmol/mol)</th><th>Range</th><th>Note</th><th></th></tr></thead>
      <tbody>{sorted.map((e,i)=>{
        const {label,cls}=classify(e.score);
        return (
          <tr key={e.id||i}>
            <td>{formatDate(e.date)}</td>
            <td>{e.score}</td>
            <td><span className={`badge ${cls}`}>{label}</span></td>
            <td style={{color:"#6b7280",fontSize:"0.8rem"}}>{e.note||""}</td>
            <td className="action-cell">
              <button className="edit-btn" onClick={()=>onEdit(e)}>✏</button>
              <button className="del-btn" onClick={()=>onDelete(e)}>✕</button>
            </td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

// ── app ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,setTab]              = useState("weight");
  const [weightEntries,setWeight] = useState(null);
  const [hba1cEntries,setHba1c]   = useState(null);
  const [status,setStatus]        = useState("");
  const [editingW,setEditingW]    = useState(null);
  const [editingH,setEditingH]    = useState(null);
  const [wProj,setWProj]          = useState(6);
  const [hProj,setHProj]          = useState(6);
  const [wLook,setWLook]          = useState(60);
  const [hLook,setHLook]          = useState(60);
  const [targetKg,setTargetKg]    = useState(null);
  const [wSection,setWSection]    = useState("chart"); // chart | monthly
  const [hSection,setHSection]    = useState("chart");

  const flash = (msg,err=false) => { setStatus({msg,err}); setTimeout(()=>setStatus(""),3000); };

  useEffect(() => {
    (async () => {
      const { data: wData, error: wErr } = await supabase.from("weight_entries").select("*").order("date",{ascending:true});
      if (wErr) { flash("Error loading weights",true); setWeight([]); }
      else if (wData.length===0) {
        const { data: seeded } = await supabase.from("weight_entries").insert(SEED_WEIGHTS).select();
        setWeight(seeded||[]);
      } else { setWeight(wData); }
      const { data: hData, error: hErr } = await supabase.from("hba1c_entries").select("*").order("date",{ascending:true});
      if (hErr) { flash("Error loading HbA1c",true); setHba1c([]); }
      else setHba1c(hData);
      // Load target from localStorage
      const t = localStorage.getItem("ht-target-kg");
      if (t) setTargetKg(parseFloat(t));
    })();
  }, []);

  const saveTarget = (kg) => {
    setTargetKg(kg);
    if (kg) localStorage.setItem("ht-target-kg", kg);
    else localStorage.removeItem("ht-target-kg");
  };

  const addWeight = async (entry) => {
    const { data, error } = await supabase.from("weight_entries").insert(entry).select().single();
    if (error) { flash("Save failed",true); return; }
    setWeight(prev=>[...prev,data]); flash("Saved ✓");
  };
  const deleteWeight = async (entry) => {
    const { error } = await supabase.from("weight_entries").delete().eq("id",entry.id);
    if (error) { flash("Delete failed",true); return; }
    setWeight(prev=>prev.filter(x=>x.id!==entry.id)); flash("Deleted");
  };
  const editWeight = async (original, updated) => {
    const { data, error } = await supabase.from("weight_entries").update(updated).eq("id",original.id).select().single();
    if (error) { flash("Update failed",true); return; }
    setWeight(prev=>prev.map(x=>x.id===original.id?data:x)); setEditingW(null); flash("Updated ✓");
  };

  const addHba1c = async (entry) => {
    const { data, error } = await supabase.from("hba1c_entries").insert(entry).select().single();
    if (error) { flash("Save failed",true); return; }
    setHba1c(prev=>[...prev,data]); flash("Saved ✓");
  };
  const deleteHba1c = async (entry) => {
    const { error } = await supabase.from("hba1c_entries").delete().eq("id",entry.id);
    if (error) { flash("Delete failed",true); return; }
    setHba1c(prev=>prev.filter(x=>x.id!==entry.id)); flash("Deleted");
  };
  const editHba1c = async (original, updated) => {
    const { data, error } = await supabase.from("hba1c_entries").update(updated).eq("id",original.id).select().single();
    if (error) { flash("Update failed",true); return; }
    setHba1c(prev=>prev.map(x=>x.id===original.id?data:x)); setEditingH(null); flash("Updated ✓");
  };

  const loading = weightEntries===null || hba1cEntries===null;

  const wFmtVal = (kg) => { const {st,lbs}=kgToStLbs(kg); return `${st}st ${lbs}lbs`; };
  const hFmtVal = (s) => `${s.toFixed(1)} mmol`;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        body{background:#0d1117;color:#e2e8f0;font-family:'DM Sans',sans-serif;min-height:100vh}
        .app{max-width:960px;margin:0 auto;padding:2rem 1.25rem 4rem}
        .header{margin-bottom:2rem;border-bottom:1px solid rgba(255,255,255,0.07);padding-bottom:1.5rem;display:flex;align-items:flex-end;justify-content:space-between}
        .header-title{font-family:'DM Serif Display',serif;font-size:2.2rem;letter-spacing:-0.02em;background:linear-gradient(135deg,#e2e8f0 0%,#94a3b8 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:0.25rem}
        .header-sub{color:#6b7280;font-size:0.875rem;font-weight:300}
        .save-status{font-size:0.8rem;min-width:80px;text-align:right}
        .tabs{display:flex;gap:0.5rem;margin-bottom:2rem;background:rgba(255,255,255,0.04);border-radius:12px;padding:4px}
        .tab{flex:1;padding:0.65rem 1rem;border:none;border-radius:9px;background:transparent;color:#6b7280;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:500;cursor:pointer;transition:all 0.2s}
        .tab.active{background:rgba(255,255,255,0.09);color:#e2e8f0}
        .tab:hover:not(.active){color:#d1d5db}
        .section{display:flex;flex-direction:column;gap:1.5rem}
        .dashboard{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.75rem}
        .dash-card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:1rem}
        .dash-label{font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;margin-bottom:0.4rem}
        .dash-value{font-size:1.15rem;font-weight:600;margin-bottom:0.2rem}
        .dash-sub{font-size:0.72rem;color:#6b7280}
        .input-card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:1.5rem;display:flex;flex-direction:column;gap:1rem}
        .input-card h3{font-family:'DM Serif Display',serif;font-size:1.15rem;color:#cbd5e1}
        .input-row{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end}
        .input-group{display:flex;flex-direction:column;gap:0.35rem}
        .input-group label{font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280}
        .input-group input{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:0.55rem 0.75rem;color:#e2e8f0;font-family:'DM Sans',sans-serif;font-size:1rem;width:90px;outline:none;transition:border-color 0.2s}
        .input-group input[type="date"]{width:160px}
        .input-group input:focus{border-color:rgba(255,255,255,0.3)}
        .note-input{width:100%}
        .note-input input{width:100%}
        .kg-display{min-width:110px}
        .kg-value{background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.2);border-radius:8px;padding:0.55rem 0.75rem;color:#34d399;font-size:1rem;white-space:nowrap}
        .add-btn{padding:0.58rem 1.5rem;background:linear-gradient(135deg,#34d399,#059669);border:none;border-radius:8px;color:#022c22;font-family:'DM Sans',sans-serif;font-weight:600;font-size:0.9rem;cursor:pointer;transition:opacity 0.2s,transform 0.1s;align-self:flex-end}
        .add-btn:hover{opacity:0.9;transform:translateY(-1px)}
        .cancel-btn{padding:0.58rem 1.5rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#9ca3af;font-family:'DM Sans',sans-serif;font-weight:500;font-size:0.9rem;cursor:pointer;align-self:flex-end}
        .cancel-btn:hover{background:rgba(255,255,255,0.1)}
        .target-btn{background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);border-radius:8px;color:#a78bfa;font-family:'DM Sans',sans-serif;font-size:0.82rem;padding:0.4rem 0.9rem;cursor:pointer;align-self:flex-start}
        .target-btn:hover{background:rgba(167,139,250,0.18)}
        .export-btn{background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.2);border-radius:8px;color:#38bdf8;font-family:'DM Sans',sans-serif;font-size:0.82rem;padding:0.4rem 0.9rem;cursor:pointer}
        .export-btn:hover{background:rgba(56,189,248,0.15)}
        .chart-card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:1.5rem}
        .chart-card h3{font-family:'DM Serif Display',serif;font-size:1.15rem;color:#cbd5e1;margin-bottom:0}
        .empty-chart{color:#4b5563;font-size:0.9rem;text-align:center;padding:3rem 1rem}
        .list-card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:1.5rem}
        .list-card h3{font-family:'DM Serif Display',serif;font-size:1.15rem;color:#cbd5e1;margin-bottom:1rem}
        .list-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem}
        .list-table{overflow-x:auto}
        table{width:100%;border-collapse:collapse;font-size:0.875rem}
        th{text-align:left;padding:0.5rem 0.75rem;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;border-bottom:1px solid rgba(255,255,255,0.07)}
        td{padding:0.65rem 0.75rem;color:#d1d5db;border-bottom:1px solid rgba(255,255,255,0.04)}
        tr:last-child td{border-bottom:none}
        tr:hover td{background:rgba(255,255,255,0.02)}
        .action-cell{display:flex;gap:0.25rem;justify-content:flex-end}
        .edit-btn{background:none;border:none;color:#4b5563;cursor:pointer;font-size:0.85rem;padding:0.2rem 0.4rem;border-radius:4px;transition:color 0.2s,background 0.2s}
        .edit-btn:hover{color:#818cf8;background:rgba(129,140,248,0.1)}
        .del-btn{background:none;border:none;color:#4b5563;cursor:pointer;font-size:0.85rem;padding:0.2rem 0.4rem;border-radius:4px;transition:color 0.2s,background 0.2s}
        .del-btn:hover{color:#ef4444;background:rgba(239,68,68,0.1)}
        .badge{display:inline-block;padding:0.15rem 0.6rem;border-radius:20px;font-size:0.72rem;font-weight:600}
        .badge-green{background:rgba(52,211,153,0.15);color:#34d399}
        .badge-amber{background:rgba(251,146,60,0.15);color:#fb923c}
        .badge-red{background:rgba(239,68,68,0.15);color:#ef4444}
        .hba1c-note{font-size:0.75rem;color:#4b5563;line-height:1.5}
        .loading{text-align:center;padding:5rem;color:#4b5563;font-size:0.9rem}
        .chart-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;margin-bottom:1.25rem}
        .chart-controls{display:flex;gap:1rem;flex-wrap:wrap;align-items:center}
        .projection-toggle{display:flex;align-items:center;gap:0.4rem;font-size:0.75rem;color:#6b7280}
        .proj-btn{padding:0.25rem 0.6rem;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#6b7280;font-size:0.75rem;cursor:pointer;transition:all 0.2s;font-family:'DM Sans',sans-serif}
        .proj-btn:hover{border-color:rgba(255,255,255,0.2);color:#d1d5db}
        .proj-btn.active{background:rgba(245,158,11,0.15);border-color:rgba(245,158,11,0.4);color:#f59e0b}
        .section-tabs{display:flex;gap:0.4rem}
        .sec-btn{padding:0.25rem 0.75rem;border-radius:6px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#6b7280;font-size:0.78rem;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.2s}
        .sec-btn.active{background:rgba(255,255,255,0.08);color:#e2e8f0;border-color:rgba(255,255,255,0.2)}
        .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}
        .modal{background:#161c2a;border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:1.75rem;width:100%;max-width:580px;display:flex;flex-direction:column;gap:1.25rem}
        .modal-header{display:flex;justify-content:space-between;align-items:center}
        .modal-header h3{font-family:'DM Serif Display',serif;font-size:1.2rem;color:#cbd5e1}
        .modal-close{background:none;border:none;color:#6b7280;font-size:1.1rem;cursor:pointer;padding:0.2rem 0.4rem;border-radius:4px}
        .modal-close:hover{color:#e2e8f0}
        .modal-actions{display:flex;gap:0.75rem;justify-content:flex-end;margin-top:0.5rem}
        .toolbar{display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center}
      `}</style>

      <div className="app">
        <div className="header">
          <div>
            <h1 className="header-title">Health Tracker - GC</h1>
            <p className="header-sub">Monitor your weight and HbA1c over time</p>
          </div>
          {status && <span className="save-status" style={{color:status.err?"#ef4444":"#34d399"}}>{status.msg}</span>}
        </div>

        {loading ? <div className="loading">Loading your data…</div> : (
          <>
            <div className="tabs">
              <button className={`tab${tab==="weight"?" active":""}`} onClick={()=>setTab("weight")}>⚖️ Weight</button>
              <button className={`tab${tab==="hba1c"?" active":""}`}  onClick={()=>setTab("hba1c")}>🩸 HbA1c</button>
            </div>

            {tab==="weight" && (
              <div className="section">
                <WeightDashboard entries={weightEntries} targetKg={targetKg} />
                <WeightInput onAdd={addWeight} />
                <div className="toolbar">
                  <TargetSetter targetKg={targetKg} onSave={saveTarget} />
                  <button className="export-btn" onClick={()=>exportCSV(weightEntries,"weight.csv",["Date","Stone","Lbs","Kg","Note"],e=>`${e.date},${e.st},${e.lbs},${e.kg},"${e.note||""}"`)}>⬇ Export CSV</button>
                </div>
                <div className="chart-card">
                  <div className="chart-header">
                    <h3>Weight Over Time</h3>
                    <div className="chart-controls">
                      <div className="projection-toggle">
                        <span>View:</span>
                        {[{d:30,l:"1m"},{d:60,l:"2m"},{d:90,l:"3m"},{d:180,l:"6m"}].map(({d,l})=>(
                          <button key={d} className={`proj-btn${wLook===d?" active":""}`} onClick={()=>setWLook(d)}>{l}</button>
                        ))}
                      </div>
                      <div className="projection-toggle">
                        <span>Trend:</span>
                        {[1,3,6,9,12].map(m=>(
                          <button key={m} className={`proj-btn${wProj===m?" active":""}`} onClick={()=>setWProj(m)}>{m}m</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <WeightChart entries={weightEntries} projectionMonths={wProj} lookbackDays={wLook} targetKg={targetKg} />
                </div>
                {weightEntries.length>0 && (
                  <div className="list-card">
                    <div className="list-card-header">
                      <h3>{wSection==="chart"?"All Entries":"Monthly Summary"}</h3>
                      <div className="section-tabs">
                        <button className={`sec-btn${wSection==="chart"?" active":""}`} onClick={()=>setWSection("chart")}>Entries</button>
                        <button className={`sec-btn${wSection==="monthly"?" active":""}`} onClick={()=>setWSection("monthly")}>Monthly</button>
                      </div>
                    </div>
                    {wSection==="chart"
                      ? <WeightList entries={weightEntries} onDelete={deleteWeight} onEdit={setEditingW} />
                      : <MonthlyTable entries={weightEntries} yKey="kg" formatVal={wFmtVal} />}
                  </div>
                )}
              </div>
            )}

            {tab==="hba1c" && (
              <div className="section">
                <HbA1cDashboard entries={hba1cEntries} />
                <HbA1cInput onAdd={addHba1c} />
                <div className="toolbar">
                  <p className="hba1c-note">Normal: below 42 mmol/mol · Pre-diabetes: 42–47 · Diabetic: 48 and above.</p>
                  <button className="export-btn" onClick={()=>exportCSV(hba1cEntries,"hba1c.csv",["Date","Score","Note"],e=>`${e.date},${e.score},"${e.note||""}"`)}>⬇ Export CSV</button>
                </div>
                <div className="chart-card">
                  <div className="chart-header">
                    <h3>HbA1c Over Time</h3>
                    <div className="chart-controls">
                      <div className="projection-toggle">
                        <span>View:</span>
                        {[{d:30,l:"1m"},{d:60,l:"2m"},{d:90,l:"3m"},{d:180,l:"6m"}].map(({d,l})=>(
                          <button key={d} className={`proj-btn${hLook===d?" active":""}`} onClick={()=>setHLook(d)}>{l}</button>
                        ))}
                      </div>
                      <div className="projection-toggle">
                        <span>Trend:</span>
                        {[1,3,6,9,12].map(m=>(
                          <button key={m} className={`proj-btn${hProj===m?" active":""}`} onClick={()=>setHProj(m)}>{m}m</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <HbA1cChart entries={hba1cEntries} projectionMonths={hProj} lookbackDays={hLook} />
                </div>
                {hba1cEntries.length>0 && (
                  <div className="list-card">
                    <div className="list-card-header">
                      <h3>{hSection==="chart"?"All Entries":"Monthly Summary"}</h3>
                      <div className="section-tabs">
                        <button className={`sec-btn${hSection==="chart"?" active":""}`} onClick={()=>setHSection("chart")}>Entries</button>
                        <button className={`sec-btn${hSection==="monthly"?" active":""}`} onClick={()=>setHSection("monthly")}>Monthly</button>
                      </div>
                    </div>
                    {hSection==="chart"
                      ? <HbA1cList entries={hba1cEntries} onDelete={deleteHba1c} onEdit={setEditingH} />
                      : <MonthlyTable entries={hba1cEntries} yKey="score" formatVal={hFmtVal} />}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {editingW && <WeightEditModal entry={editingW} onSave={u=>editWeight(editingW,u)} onClose={()=>setEditingW(null)} />}
      {editingH && <HbA1cEditModal entry={editingH} onSave={u=>editHba1c(editingH,u)} onClose={()=>setEditingH(null)} />}
    </>
  );
}
