/**
 * The dashboard's single HTML page (served at '/').
 *
 * Plain string on purpose: no build step, no framework, works under bun and
 * node alike. The page script avoids template literals so this file needs
 * no backtick escaping. Charts: TradingView Lightweight Charts (CDN).
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dexter — paper book</title>
<script src="https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#21262d; --fg:#c9d1d9; --dim:#8b949e;
          --green:#3fb950; --red:#f85149; --blue:#58a6ff; --orange:#d29922; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--fg); font:13px/1.45 -apple-system,'Segoe UI',sans-serif; }
  header { display:flex; gap:18px; align-items:baseline; padding:10px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  header .t { font-weight:700; font-size:15px; }
  header .halt-on { color:var(--red); font-weight:700; }
  header .halt-off { color:var(--green); }
  .wrap { display:flex; height:calc(100vh - 43px); }
  aside { width:340px; overflow-y:auto; border-right:1px solid var(--line); padding:10px 12px; }
  main { flex:1; display:flex; flex-direction:column; min-width:0; }
  #chart { flex:1; }
  .bar { display:flex; gap:8px; padding:8px 12px; align-items:center; border-bottom:1px solid var(--line); }
  .bar .sym { font-size:16px; font-weight:700; }
  h3 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:14px 0 6px; }
  table { width:100%; border-collapse:collapse; }
  td { padding:3px 4px; border-bottom:1px solid var(--line); white-space:nowrap; }
  tr.row { cursor:pointer; } tr.row:hover { background:var(--panel); }
  tr.sel { background:#1c2430; }
  .r { text-align:right; } .g { color:var(--green); } .b { color:var(--red); }
  .dim { color:var(--dim); } .chip { font-size:10px; border:1px solid var(--line); border-radius:8px; padding:0 6px; color:var(--dim); }
  button { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:4px 10px; cursor:pointer; }
  button.on { border-color:var(--blue); color:var(--blue); }
  .legend { font-size:11px; color:var(--dim); padding:4px 12px; }
</style>
</head>
<body>
<header>
  <span class="t">dexter · paper book</span>
  <span id="netliq" class="dim"></span>
  <span id="dpnl"></span>
  <span id="halt"></span>
  <span id="asof" class="dim" style="margin-left:auto"></span>
</header>
<div class="wrap">
  <aside>
    <h3>Positions</h3><table id="positions"></table>
    <h3>Working orders</h3><table id="orders"></table>
    <h3>Proposals</h3><table id="proposals"></table>
    <h3>Profit trail</h3><table id="trail"></table>
    <h3>Swing candidates (last scan)</h3><table id="patterns"></table>
  </aside>
  <main>
    <div class="bar">
      <span class="sym" id="cursym">—</span>
      <button id="tf1m">1-min</button>
      <button id="tf1d">Daily</button>
      <span class="legend">lines: <span style="color:#58a6ff">entry</span> ·
        <span style="color:#f85149">stop</span> ·
        <span style="color:#3fb950">target</span> ·
        <span style="color:#d29922">trail peak</span></span>
    </div>
    <div id="chart"></div>
  </main>
</div>
<script>
var state = { overview:null, symbol:null, tf:'1min', chart:null, series:null, lines:[] };

function el(id){ return document.getElementById(id); }
function fmt(n,d){ return n==null||isNaN(n) ? '—' : Number(n).toFixed(d==null?2:d); }
function pnlSpan(v){ if(v==null) return '<span class="dim">—</span>';
  var c = v>=0?'g':'b', s = v>=0?'+':''; return '<span class="'+c+'">'+s+fmt(v)+'</span>'; }

function initChart(){
  var opts = { layout:{ background:{color:'#0d1117'}, textColor:'#8b949e' },
    grid:{ vertLines:{color:'#161b22'}, horzLines:{color:'#161b22'} },
    timeScale:{ timeVisible:true, secondsVisible:false },
    rightPriceScale:{ borderColor:'#21262d' }, crosshair:{ mode:0 } };
  state.chart = LightweightCharts.createChart(el('chart'), opts);
  state.series = state.chart.addCandlestickSeries({
    upColor:'#3fb950', downColor:'#f85149', wickUpColor:'#3fb950', wickDownColor:'#f85149', borderVisible:false });
  new ResizeObserver(function(){ state.chart.applyOptions({}); }).observe(el('chart'));
}

function clearLines(){ state.lines.forEach(function(l){ state.series.removePriceLine(l); }); state.lines = []; }
function addLine(price, color, title, dashed){
  if(price==null || isNaN(price)) return;
  state.lines.push(state.series.createPriceLine({ price:Number(price), color:color, lineWidth:1,
    lineStyle: dashed?LightweightCharts.LineStyle.Dashed:LightweightCharts.LineStyle.Solid, title:title }));
}

function overlayFor(symbol){
  clearLines();
  var o = state.overview; if(!o) return;
  (o.positions||[]).forEach(function(p){ if(p.symbol===symbol) addLine(p.avgCost, '#58a6ff', 'avg '+fmt(p.avgCost)); });
  (o.proposals||[]).forEach(function(p){
    if(p.symbol!==symbol) return;
    if(p.status==='executed'||p.status==='executing'){ addLine(p.stop,'#f85149','stop '+p.id); addLine(p.target,'#3fb950','tgt '+p.id); }
    if(p.status==='open'){ addLine(p.entry,'#8b949e',p.id+' entry', true); }
  });
  (o.trail||[]).forEach(function(t){ if(t.symbol===symbol) addLine(t.best, '#d29922', (t.armed?'peak (armed)':'peak'), true); });
}

function selectSymbol(sym){
  state.symbol = sym; el('cursym').textContent = sym;
  document.querySelectorAll('tr.row').forEach(function(tr){ tr.classList.toggle('sel', tr.dataset.sym===sym); });
  loadBars();
}

function loadBars(){
  if(!state.symbol) return;
  fetch('/api/bars?symbol='+encodeURIComponent(state.symbol)+'&size='+(state.tf==='1d'?'1d':'1min'))
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d.bars) return;
      state.series.setData(d.bars);
      state.chart.timeScale().fitContent();
      overlayFor(state.symbol);
    })
    .catch(function(){});
}

function renderOverview(o){
  state.overview = o;
  el('asof').textContent = new Date(o.at).toLocaleTimeString();
  if(o.loss){
    el('netliq').textContent = o.loss.netLiquidation ? 'NetLiq $'+Math.round(o.loss.netLiquidation).toLocaleString() : '';
    el('dpnl').innerHTML = o.loss.dailyPnL!=null ? 'Day '+pnlSpan(o.loss.dailyPnL) : '';
    el('halt').innerHTML = o.loss.halted ? '<span class="halt-on">⛔ HALTED</span>' : '<span class="halt-off">● trading allowed</span>';
  }
  var pos = (o.positions||[]).map(function(p){
    return '<tr class="row" data-sym="'+p.symbol+'"><td><b>'+p.symbol+'</b></td>'+
      '<td class="r">'+(p.quantity>0?'+':'')+p.quantity+'</td>'+
      '<td class="r dim">@'+fmt(p.avgCost)+'</td></tr>'; }).join('');
  el('positions').innerHTML = pos || '<tr><td class="dim">flat</td></tr>';

  var ord = (o.orders||[]).map(function(x){
    var px = x.limitPrice || x.auxPrice || '';
    return '<tr class="row" data-sym="'+x.symbol+'"><td>#'+(x.orderId||'?')+'</td><td>'+x.action+' '+x.quantity+' <b>'+x.symbol+'</b></td>'+
      '<td class="r">'+x.orderType+(px?' @'+px:'')+'</td><td class="chip">'+(x.status||'')+'</td></tr>'; }).join('');
  el('orders').innerHTML = ord || '<tr><td class="dim">none</td></tr>';

  var props = (o.proposals||[]).filter(function(p){ return ['open','executing','executed'].indexOf(p.status)>=0; })
    .map(function(p){
      return '<tr class="row" data-sym="'+p.symbol+'"><td>'+p.id+'</td><td><b>'+p.symbol+'</b> '+p.direction+'</td>'+
        '<td class="r dim">@'+fmt(p.entry)+'</td><td class="chip">'+p.status+(p.score?' · '+p.score:'')+'</td></tr>'; }).join('');
  el('proposals').innerHTML = props || '<tr><td class="dim">none</td></tr>';

  var tr = (o.trail||[]).map(function(t){
    var gain = t.direction==='long' ? (t.best-t.basis)/t.basis*100 : (t.basis-t.best)/t.basis*100;
    return '<tr class="row" data-sym="'+t.symbol+'"><td><b>'+t.symbol+'</b></td>'+
      '<td class="r">peak '+fmt(t.best)+'</td><td class="r '+(gain>=0?'g':'b')+'">'+fmt(gain,1)+'%</td>'+
      '<td class="chip">'+(t.armed?'ARMED':'watching')+'</td></tr>'; }).join('');
  el('trail').innerHTML = tr || '<tr><td class="dim">no positions watched</td></tr>';

  var pat = (o.patterns||[]).map(function(c){
    return '<tr class="row" data-sym="'+c.symbol+'"><td><b>'+c.symbol+'</b></td><td class="dim">'+c.pattern+'</td>'+
      '<td class="r">'+c.score+'</td></tr>'; }).join('');
  el('patterns').innerHTML = pat || '<tr><td class="dim">none</td></tr>';

  document.querySelectorAll('tr.row').forEach(function(row){
    row.addEventListener('click', function(){ selectSymbol(row.dataset.sym); });
    row.classList.toggle('sel', row.dataset.sym===state.symbol);
  });

  if(!state.symbol && o.positions && o.positions.length) selectSymbol(o.positions[0].symbol);
  else if(state.symbol) overlayFor(state.symbol);
}

function refresh(){
  fetch('/api/overview').then(function(r){ return r.json(); }).then(renderOverview).catch(function(){});
}

el('tf1m').addEventListener('click', function(){ state.tf='1min'; setTf(); });
el('tf1d').addEventListener('click', function(){ state.tf='1d'; setTf(); });
function setTf(){ el('tf1m').classList.toggle('on', state.tf==='1min');
  el('tf1d').classList.toggle('on', state.tf==='1d'); loadBars(); }

initChart(); setTf(); refresh();
setInterval(refresh, 30000);
setInterval(loadBars, 60000);
</script>
</body>
</html>`;
