/*
 * HumanRain — rainfall in millimetres, converted to glasses of water.
 * Copyright (C) 2026  <YOUR NAME>
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU Affero General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option) any
 * later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more
 * details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* HumanRain — one search box for places, trails and GPX files.
   Places get the next rain window. Routes get an average pace from Naismith's
   rule and an hour-by-hour walk through the forecast at the route's midpoint. */
(function(){
  'use strict';

  var R = 6371000;
  var BASE_KMH = 5;      // Naismith: 5 km/h on the flat
  var ASCENT_MPH = 600;  // plus an hour per 600 m of ascent
  var el = {};
  ['q','suggest','gpx','status','out','outHead','outSub','placeView','hours','hticks',
   'legs','routeOpts','startAt','fitness'].forEach(function(k){ el[k] = document.getElementById(k); });

  function say(m){ el.status.textContent = m || ''; }
  function fit(){ return parseFloat(el.fitness.querySelector('[aria-pressed=true]').dataset.v); }

  function dist(a,b){
    var p1=a.lat*Math.PI/180, p2=b.lat*Math.PI/180;
    var dp=p2-p1, dl=(b.lon-a.lon)*Math.PI/180;
    var h=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
    return 2*R*Math.asin(Math.sqrt(h));
  }
  function hhmm(unix, off){
    var d=new Date((unix+(off||0))*1000), h=d.getUTCHours(), m=d.getUTCMinutes();
    return (h<10?'0':'')+h+':'+(m<10?'0':'')+m;
  }
  function pad(n){ return (n<10?'0':'')+n; }

  /* ================= autocomplete ================= */

  var timer=null, seq=0, items=[], cursor=-1;

  function parseCoords(s){
    var m=s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if(!m) return null;
    var la=+m[1], lo=+m[2];
    if(Math.abs(la)>90||Math.abs(lo)>180) return null;
    return {kind:'place', label:la.toFixed(3)+', '+lo.toFixed(3), sub:'coordinates', lat:la, lon:lo};
  }

  function drawList(){
    if(!items.length){ el.suggest.hidden=true; el.q.setAttribute('aria-expanded','false'); return; }
    el.suggest.innerHTML = items.map(function(it,i){
      return '<li role="option" id="opt'+i+'" aria-selected="'+(i===cursor)+'" data-i="'+i+'"'+
             (i===cursor?' class="on"':'')+'>'+
             '<span class="tag tag-'+it.kind+'">'+(it.kind==='route'?'trail':'place')+'</span>'+
             '<span class="s-main">'+esc(it.label)+'</span>'+
             '<span class="s-sub">'+esc(it.sub||'')+'</span></li>';
    }).join('');
    el.suggest.hidden=false;
    el.q.setAttribute('aria-expanded','true');
  }
  function esc(s){ return String(s).replace(/[<>&]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c]; }); }
  function closeList(){ items=[]; cursor=-1; el.suggest.hidden=true; el.q.setAttribute('aria-expanded','false'); }

  el.q.addEventListener('input', function(){
    var v = el.q.value.trim();
    clearTimeout(timer);
    if(!v){ closeList(); return; }
    var c = parseCoords(v);
    if(c){ items=[c]; cursor=0; drawList(); return; }
    if(v.length < 2){ closeList(); return; }
    timer = setTimeout(function(){ suggest(v); }, 220);
  });

  function suggest(v){
    var my = ++seq;
    fetch('https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name='+encodeURIComponent(v))
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(my !== seq) return;
        items = (d.results||[]).map(function(h){
          return {kind:'place', label:h.name, lat:h.latitude, lon:h.longitude,
                  sub:[h.admin1, h.country].filter(Boolean).join(', ')};
        });
        cursor = -1; drawList();
      })
      .catch(function(){ if(my===seq){ say('Couldn\u2019t reach the search service.'); } });

    // Trails come from Overpass, which is slow and rate-limits hard, so it gets a
    // longer leash and only fires on queries long enough to be a real name.
    if(v.length >= 4){
      clearTimeout(suggest.t);
      suggest.t = setTimeout(function(){
        var mine = seq;
        overpass('[out:json][timeout:20];relation["route"~"hiking|foot"]["name"~"'+
                 v.replace(/["\\]/g,'')+'",i];out tags 6;')
          .then(function(d){
            if(mine !== seq) return;
            var add = (d.elements||[]).filter(function(e){ return e.tags && e.tags.name; })
              .map(function(h){
                return {kind:'route', label:h.tags.name, id:h.id,
                        sub:[h.tags.distance ? h.tags.distance+' km' : null,
                             h.tags.symbol || h.tags.network || 'hiking route'].filter(Boolean).join(' \u00b7 ')};
              });
            if(add.length){ items = items.concat(add); drawList(); }
          })
          .catch(function(){});
      }, 650);
    }
  }

  el.q.addEventListener('keydown', function(e){
    if(el.suggest.hidden){ if(e.key==='Enter' && items.length) choose(items[0]); return; }
    if(e.key==='ArrowDown'){ cursor=Math.min(cursor+1, items.length-1); drawList(); e.preventDefault(); }
    else if(e.key==='ArrowUp'){ cursor=Math.max(cursor-1, 0); drawList(); e.preventDefault(); }
    else if(e.key==='Enter'){ choose(items[cursor<0?0:cursor]); e.preventDefault(); }
    else if(e.key==='Escape'){ closeList(); }
  });
  el.suggest.addEventListener('mousedown', function(e){
    var li=e.target.closest('li'); if(!li) return;
    e.preventDefault(); choose(items[+li.dataset.i]);
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('.finder')) closeList();
  });

  function choose(it){
    if(!it) return;
    el.q.value = it.label;
    closeList();
    if(it.kind === 'place') loadPlace(it.lat, it.lon, it.label);
    else loadRoute(it.id, it.label);
  }

  function overpass(query){
    return fetch('https://overpass-api.de/api/interpreter', {
      method:'POST', body:'data='+encodeURIComponent(query),
      headers:{'Content-Type':'application/x-www-form-urlencoded'}
    }).then(function(r){ if(!r.ok) throw 0; return r.json(); });
  }

  /* ================= place mode ================= */

  var fc = null;

  function loadPlace(lat, lon, label){
    el.routeOpts.hidden = true;
    say('Fetching the forecast for '+label+'\u2026');
    fetch('https://api.open-meteo.com/v1/forecast?timeformat=unixtime&timezone=auto&forecast_days=3'+
          '&hourly=precipitation,wind_speed_10m&latitude='+lat.toFixed(4)+'&longitude='+lon.toFixed(4))
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(d){ showPlace(d, label); })
      .catch(function(){ say('Couldn\u2019t reach the forecast service. The sliders below still work.'); });
  }

  function showPlace(d, label){
    var t=d.hourly.time, p=d.hourly.precipitation, w=d.hourly.wind_speed_10m;
    var now=Date.now()/1000, i0=0;
    while(i0<t.length-1 && t[i0+1]<=now) i0++;
    fc = {t:t,p:p,w:w,off:d.utc_offset_seconds||0,i0:i0,label:label};

    say(''); el.out.hidden=false; el.placeView.hidden=false; el.legs.hidden=true;

    var start=-1,end=-1;
    for(var i=i0;i<Math.min(t.length,i0+48);i++){ if(p[i]>=0.1){ start=i; break; } }
    if(start>-1){ end=start; while(end+1<t.length && p[end+1]>=0.1) end++; }

    if(start===-1){
      el.outHead.textContent='No rain forecast in '+label+' for the next two days.';
      el.outSub.textContent='Nothing to model \u2014 tap an hour below, or move the sliders by hand.';
    }else{
      var total=0; for(var j=start;j<=end;j++) total+=p[j];
      var hrs=end-start+1;
      el.outHead.textContent=(start===i0?'Raining now':'Rain from '+hhmm(t[start],fc.off))+
        ' \u2014 '+total.toFixed(1)+' mm over '+hrs+' hour'+(hrs>1?'s':'')+'.';
      el.outSub.textContent=label+' \u00b7 wind '+Math.round(w[start])+' km/h \u00b7 applied to the numbers above.';
      window.WetMetre.setRain(total, hrs);
    }
    drawHours();
  }

  function drawHours(){
    var html='', cap=4;
    for(var k=0;k<24;k++){
      var i=fc.i0+k, mm=fc.p[i]||0;
      var pct=Math.max(3, Math.min(100, mm/cap*100));
      html+='<button class="hbar" data-i="'+i+'" data-wet="'+(mm>=0.1?'y':'n')+'" aria-pressed="false" '+
            'title="'+hhmm(fc.t[i],fc.off)+' \u2014 '+mm.toFixed(1)+' mm"><i style="height:'+pct+'%"></i></button>';
    }
    el.hours.innerHTML=html;
    el.hticks.innerHTML='<span>'+hhmm(fc.t[fc.i0],fc.off)+'</span><span>'+
      hhmm(fc.t[fc.i0+11],fc.off)+'</span><span>'+hhmm(fc.t[fc.i0+23],fc.off)+'</span>';
  }

  el.hours.addEventListener('click', function(e){
    var b=e.target.closest('.hbar'); if(!b||!fc) return;
    [].forEach.call(el.hours.querySelectorAll('.hbar'), function(x){ x.setAttribute('aria-pressed', x===b); });
    var i=+b.dataset.i, mm=fc.p[i]||0;
    el.outHead.textContent=hhmm(fc.t[i],fc.off)+' \u2014 '+mm.toFixed(1)+' mm in that hour.';
    el.outSub.textContent=fc.label+' \u00b7 wind '+Math.round(fc.w[i])+' km/h \u00b7 applied to the numbers above.';
    window.WetMetre.setRain(mm, 1);
    scrollTo({top:0, behavior:'smooth'});
  });

  /* ================= routes ================= */

  function parseGPX(text){
    var doc=new DOMParser().parseFromString(text,'application/xml');
    if(doc.querySelector('parsererror')) throw new Error('That file isn\u2019t valid GPX.');
    var nodes=doc.getElementsByTagName('trkpt');
    if(!nodes.length) nodes=doc.getElementsByTagName('rtept');
    if(!nodes.length) throw new Error('No track points in that file \u2014 export the tour as a GPX track.');
    var pts=[], nm=doc.getElementsByTagName('name')[0];
    for(var i=0;i<nodes.length;i++){
      var n=nodes[i], e=n.getElementsByTagName('ele')[0];
      pts.push({lat:parseFloat(n.getAttribute('lat')), lon:parseFloat(n.getAttribute('lon')),
                ele:e?parseFloat(e.textContent):null});
    }
    return {points:pts, name:nm?nm.textContent.trim():'Your route'};
  }

  function stitch(ways){
    var pool=ways.slice(), chain=pool.shift(), tol=60, moved=true;
    if(!chain) return [];
    while(pool.length && moved){
      moved=false;
      var head=chain[0], tail=chain[chain.length-1];
      for(var i=0;i<pool.length;i++){
        var w=pool[i], a=w[0], b=w[w.length-1];
        if(dist(tail,a)<tol) chain=chain.concat(w.slice(1));
        else if(dist(tail,b)<tol) chain=chain.concat(w.slice().reverse().slice(1));
        else if(dist(head,b)<tol) chain=w.slice(0,-1).concat(chain);
        else if(dist(head,a)<tol) chain=w.slice().reverse().slice(0,-1).concat(chain);
        else continue;
        pool.splice(i,1); moved=true; break;
      }
    }
    return chain;
  }

  function loadRoute(id, name){
    say('Loading \u201c'+name+'\u201d from OpenStreetMap\u2026');
    overpass('[out:json][timeout:60];relation('+id+');out geom;')
      .then(function(d){
        var rel=(d.elements||[])[0];
        if(!rel||!rel.members){ say('That route has no geometry in OpenStreetMap.'); return; }
        var ways=rel.members.filter(function(m){ return m.type==='way' && m.geometry && m.geometry.length>1; })
                            .map(function(m){ return m.geometry.map(function(g){ return {lat:g.lat, lon:g.lon, ele:null}; }); });
        if(!ways.length){ say('That route has no usable path geometry.'); return; }
        var line=stitch(ways);
        if(line.length<2){ say('Couldn\u2019t assemble that route into one path \u2014 it may be split into disconnected sections.'); return; }
        runRoute(name, line);
      })
      .catch(function(){ say('Overpass didn\u2019t answer \u2014 it rate-limits hard. Wait a minute, or load the GPX instead.'); });
  }

  /* thin a route down to ~120 evenly spaced nodes: enough for distance,
     ascent and a midpoint, and coarse enough to shrug off GPS jitter */
  function thin(pts, want){
    var cum=[0], total=0;
    for(var i=1;i<pts.length;i++){ total+=dist(pts[i-1],pts[i]); cum.push(total); }
    if(total===0) return {nodes:pts.slice(0,1), total:0};
    var n=Math.min(want, Math.max(2, pts.length)), out=[], j=0;
    for(var k=0;k<n;k++){
      var target=total*k/(n-1);
      while(j<cum.length-1 && cum[j+1]<target) j++;
      out.push(pts[j]);
    }
    return {nodes:out, total:total};
  }

  function elevations(nodes){
    if(nodes.every(function(p){ return p.ele != null; })) return Promise.resolve(nodes);
    var la=nodes.map(function(p){ return p.lat.toFixed(5); }).join(',');
    var lo=nodes.map(function(p){ return p.lon.toFixed(5); }).join(',');
    return fetch('https://api.open-meteo.com/v1/elevation?latitude='+la+'&longitude='+lo)
      .then(function(r){ return r.json(); })
      .then(function(d){ (d.elevation||[]).forEach(function(e,i){ if(nodes[i]) nodes[i].ele=e; }); return nodes; })
      .catch(function(){ nodes.forEach(function(p){ if(p.ele==null) p.ele=0; }); return nodes; });
  }

  function runRoute(name, raw){
    el.routeOpts.hidden = false;
    if(!el.startAt.value) defaultStart();
    say('Measuring the route\u2026');
    var t = thin(raw, 120);
    if(t.total < 100){ say('That route is shorter than 100 m.'); return; }

    elevations(t.nodes).then(function(nodes){
      var gain=0;
      for(var i=1;i<nodes.length;i++){
        var dz=(nodes[i].ele||0)-(nodes[i-1].ele||0);
        if(dz>0) gain+=dz;
      }
      var mid=nodes[Math.floor(nodes.length/2)];
      last = {name:name, total:t.total, gain:gain, mid:mid};
      forecastRoute();
    });
  }

  var last = null;

  function forecastRoute(){
    if(!last) return;
    say('Fetching the forecast along the route\u2026');
    fetch('https://api.open-meteo.com/v1/forecast?timeformat=unixtime&timezone=auto&forecast_days=3'+
          '&hourly=precipitation,snowfall,wind_speed_10m&latitude='+last.mid.lat.toFixed(4)+
          '&longitude='+last.mid.lon.toFixed(4))
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(showRoute)
      .catch(function(){ say('Couldn\u2019t reach the forecast service. The route measured fine \u2014 try again.'); });
  }

  function showRoute(d){
    var W=window.WetMetre, f=fit();
    var km=last.total/1000;
    // Naismith: an hour per 5 km, plus an hour per 600 m of ascent
    var hours=(km/(BASE_KMH*f)) + (last.gain/(ASCENT_MPH*f));
    var speed=last.total/(hours*3600);           // one average speed for the walk

    var startVal=el.startAt.value;
    var t0=startVal ? Math.floor(new Date(startVal).getTime()/1000) : Math.floor(Date.now()/1000);
    var t1=t0+hours*3600;

    var t=d.hourly.time, p=d.hourly.precipitation, s=d.hourly.snowfall,
        w=d.hourly.wind_speed_10m, off=d.utc_offset_seconds||0;

    var vTop=0, vFront=0, snow=0, gap=0, rows=[], cover=W.cover();
    for(var i=0;i<t.length;i++){
      var hs=t[i], he=hs+3600;
      var a=Math.max(t0,hs), b=Math.min(t1,he);
      if(b<=a) continue;
      var dt=b-a;
      var v=W.compute(p[i]||0, dt, speed, cover);
      vTop+=v.top; vFront+=v.front;
      snow=Math.max(snow, s[i]||0);
      rows.push({t:hs, mm:p[i]||0, wind:w[i]||0, l:(v.top+v.front)*1000,
                 d0:(a-t0)*speed, d1:(b-t0)*speed});
    }
    var covered=rows.reduce(function(n,r){ return n+(r.d1-r.d0); },0);
    gap=last.total-covered;

    W.paint(vTop, vFront);
    el.out.hidden=false; el.placeView.hidden=true; el.legs.hidden=false;

    var hh=Math.floor(hours), mm=Math.round((hours-hh)*60);
    el.outHead.textContent=last.name;
    el.outSub.textContent=km.toFixed(1)+' km \u00b7 '+Math.round(last.gain)+' m up \u00b7 about '+
      hh+'h '+pad(mm)+' at '+(speed*3.6).toFixed(1)+' km/h average';

    var wettest=null;
    rows.forEach(function(r){ if(!wettest||r.l>wettest.l) wettest=r; });
    el.legs.innerHTML = rows.length ? rows.map(function(r){
      var hot = wettest && r.t===wettest.t && r.l>0.02;
      return '<div class="leg'+(hot?' leg-hot':'')+'">'+
             '<span class="leg-t">'+hhmm(r.t,off)+'</span>'+
             '<span class="leg-d">km '+(r.d0/1000).toFixed(1)+'\u2013'+(r.d1/1000).toFixed(1)+'</span>'+
             '<span class="leg-r">'+r.mm.toFixed(1)+' mm/h</span>'+
             '<span class="leg-l">'+(r.l<0.01?'\u2014':r.l.toFixed(2)+' L')+'</span></div>';
    }).join('') : '<p class="hint">This walk falls outside the forecast window.</p>';

    var notes=[];
    if(snow>0.1) notes.push('Snow forecast here \u2014 the litres are an upper bound on wetness and mostly a warning about cold.');
    if(gap>100) notes.push('The forecast reaches three days out; the last '+(gap/1000).toFixed(1)+' km falls beyond it and counts as dry.');
    if(wettest && wettest.l>0.02) notes.push('Wettest stretch: km '+(wettest.d0/1000).toFixed(1)+'\u2013'+
      (wettest.d1/1000).toFixed(1)+' from '+hhmm(wettest.t,off)+'.');
    say(notes.join(' '));
  }

  /* ================= inputs ================= */

  el.gpx.addEventListener('change', function(e){
    var f=e.target.files && e.target.files[0];
    if(!f) return;
    say('Reading '+f.name+'\u2026');
    var fr=new FileReader();
    fr.onload=function(){
      try{
        var g=parseGPX(fr.result);
        el.q.value=g.name;
        runRoute(g.name || f.name.replace(/\.gpx$/i,''), g.points);
      }catch(err){ say(err.message); }
    };
    fr.onerror=function(){ say('Couldn\u2019t read that file.'); };
    fr.readAsText(f);
  });

  el.fitness.addEventListener('click', function(e){
    var b=e.target.closest('.chip'); if(!b) return;
    [].forEach.call(el.fitness.querySelectorAll('.chip'), function(c){ c.setAttribute('aria-pressed', c===b); });
    if(last) forecastRoute();
  });
  el.startAt.addEventListener('change', function(){ if(last) forecastRoute(); });

  function defaultStart(){
    var d=new Date(Date.now()+3600000); d.setMinutes(0,0,0);
    el.startAt.value=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':00';
  }
  defaultStart();

})();
