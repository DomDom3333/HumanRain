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
  var DAYS = 7;          // how far ahead Open-Meteo is asked to look
  var el = {};
  ['q','suggest','gpx','status','retry','out','outHead','outSub','placeView','days','hours','hticks',
   'legs','routeOpts','startAt','fitness'].forEach(function(k){ el[k] = document.getElementById(k); });

  var again = null;
  function say(m, working){
    el.status.textContent = m || '';
    el.status.classList.toggle('working', !!working && !!m);
    again = null; el.retry.hidden = true;          // any new word clears the old offer
  }

  /* Both of these services rate-limit, and a refused call is usually fine a moment
     later — so a dead end offers the retry rather than describing one. */
  function offer(fn, label){
    again = fn;
    el.retry.textContent = label || 'Try again';
    el.retry.hidden = false;
  }
  function fail(m, retry){ say(m); if(retry) offer(retry); }

  el.retry.addEventListener('click', function(){
    var go = again;
    if(go){ el.retry.hidden = true; go(); }
  });
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

  /* Days are counted where the rain falls, not where the phone is: "tomorrow"
     on a forecast is the forecast's tomorrow. */
  function dayOf(unix, off){ return Math.floor((unix+(off||0))/86400); }
  var WEEK = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  function dayName(key, today){
    if(key === today) return 'Today';
    if(key === today+1) return 'Tomorrow';
    var d = new Date(key*86400000);
    return WEEK[d.getUTCDay()]+' '+d.getUTCDate();
  }

  /* ================= autocomplete ================= */

  var timer=null, seq=0, items=[], cursor=-1;

  function parseCoords(s){
    var m=s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if(!m) return null;
    var la=+m[1], lo=+m[2];
    if(Math.abs(la)>90||Math.abs(lo)>180) return null;
    return {kind:'place', label:la.toFixed(3)+', '+lo.toFixed(3), sub:'coordinates', lat:la, lon:lo};
  }

  /* Anything named in OpenStreetMap that you can walk *along* — a gorge, a
     ridge, a marked path — is a route, not a dot. Everything else is a place. */
  var LINEAR = {
    route:   {hiking:'hiking route', foot:'walking route', walking:'walking route'},
    natural: {gorge:'gorge', valley:'valley', ridge:'ridge', arete:'arête'},
    highway: {path:'path', footway:'footway', track:'track', bridleway:'bridleway'}
  };
  function linear(k, v, osmType){
    if(osmType !== 'W' && osmType !== 'R') return null;      // a node is never a line
    return (LINEAR[k] || {})[v] || null;
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

  /* Three sources, each answering when it can: the gazetteer knows towns, Photon
     knows every named feature in OpenStreetMap, Overpass knows waymarked trails
     by name. Results are merged as they land rather than awaited together. */
  var bucket = {towns:[], osm:[], trails:[]};

  /* Each source keeps a few slots of its own, so a waymarked trail still shows
     even when a dozen streets share its name. */
  var SLOTS = {towns:3, osm:4, trails:3};

  /* Two hits with one name a few kilometres apart are one thing on the ground:
     a gorge and the viewpoint over it, a trail and its trailhead. Keep a single
     row for it, and prefer the one that can be walked. */
  function same(a, b){
    return a.label.toLowerCase() === b.label.toLowerCase() && dist(a, b) < 15000;
  }

  function merge(){
    var out = [];
    ['towns','osm','trails'].forEach(function(b){
      var n = 0;
      bucket[b].forEach(function(it){
        for(var i=0;i<out.length;i++){
          if(!same(out[i], it)) continue;
          if(it.kind==='route' && out[i].kind!=='route') out[i]=it;
          return;
        }
        if(n >= SLOTS[b]) return;
        n++; out.push(it);
      });
    });
    items = out; cursor = -1; drawList();
  }

  function fromGazetteer(h){
    return {kind:'place', label:h.name, lat:h.latitude, lon:h.longitude,
            sub:[h.admin1, h.country].filter(Boolean).join(', ')};
  }

  /* Photon hands back the OSM object behind each hit, so a gorge or a ridge can
     be walked as a route instead of collapsing to a single dot on the map. */
  function fromPhoton(f){
    var p = f.properties || {}, c = (f.geometry||{}).coordinates;
    if(!p.name || !c) return null;
    var where = [p.city || p.district || p.county, p.state, p.country].filter(Boolean).join(', ');
    var line = linear(p.osm_key, p.osm_value, p.osm_type);
    var it = {kind: line ? 'route' : 'place', label:p.name, lat:c[1], lon:c[0],
              sub:[line, where].filter(Boolean).join(' \u00b7 ')};
    if(line) it.osm = {type:p.osm_type, id:p.osm_id};
    return it;
  }

  function rx(s){ return s.replace(/["\\]/g,'').replace(/[\^$.*+?()[\]{}|]/g, '\\$&'); }

  /* A request that never answers is worse than one that fails: the page just sits
     there. Everything here is given a deadline. */
  var JSON_MS = 20000;
  function json(url){
    var ctl = new AbortController();
    var bell = setTimeout(function(){ ctl.abort(); }, JSON_MS);
    return fetch(url, {signal:ctl.signal})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(d){ clearTimeout(bell); return d; },
            function(e){ clearTimeout(bell); throw e; });
  }
  function fill(b, my, list){
    if(my !== seq) return;               // a newer keystroke has already taken over
    bucket[b] = list; merge();
  }

  /* The trail sweep is the slow one. A newer keystroke, or picking something,
     makes its answer worthless — so it is called off rather than left to hold a
     mirror that the picked trail is about to need. */
  var trailCtl = null, trailGen = 0;
  function dropTrailSearch(){
    trailGen++;                    // also disowns the worldwide retry, which has no request yet
    if(trailCtl){ trailCtl.abort(); trailCtl = null; }
  }

  function suggest(v){
    var my = ++seq;
    dropTrailSearch();
    bucket = {towns:[], osm:[], trails:[]};

    var towns = json('https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name='+
                     encodeURIComponent(v))
      .then(function(d){ fill('towns', my, (d.results||[]).map(fromGazetteer)); return true; })
      .catch(function(){ return false; });

    var osm = json('https://photon.komoot.io/api?limit=8&lang=en&q='+encodeURIComponent(v))
      .then(function(d){ fill('osm', my, (d.features||[]).map(fromPhoton).filter(Boolean)); return true; })
      .catch(function(){ return false; });

    // Trails come from Overpass, which is slow and rate-limits hard, so it only
    // fires on queries long enough to be a real name — and only once the
    // geocoders have come back, since their answer is what bounds the search.
    Promise.all([towns, osm]).then(function(ok){
      if(my !== seq) return;
      if(!ok[0] && !ok[1]){ say('Couldn\u2019t reach the search service.'); return; }
      if(v.length >= 4) soon(function(){ if(my === seq) findTrails(v, my); });
    });
  }

  function soon(fn){ clearTimeout(soon.t); soon.t = setTimeout(fn, 250); }

  /* A name search across every route relation on earth takes Overpass longer than
     it is willing to spend, so it is fenced to a box around whatever the
     geocoders just found \u2014 that box is where the walk almost always is. Only if
     it comes back empty is the whole world worth the wait. */
  function findTrails(v, my){
    var near = bucket.osm[0] || bucket.towns[0], gen = trailGen;
    trailsNear(v, my, near).then(function(found){
      if(!found && near && gen === trailGen && my === seq) trailsNear(v, my, null);
    });
  }

  function trailsNear(v, my, near){
    var pad = 0.7, box = near
      ? '('+(near.lat-pad).toFixed(3)+','+(near.lon-pad).toFixed(3)+','+
            (near.lat+pad).toFixed(3)+','+(near.lon+pad).toFixed(3)+')'
      : '';
    trailCtl = new AbortController();
    return overpass('[out:json][timeout:'+(box?25:45)+'];relation["route"~"hiking|foot|walking"]'+
                    '["name"~"'+rx(v)+'",i]'+box+';out center tags 6;', trailCtl.signal)
      .then(function(d){
        var found = (d.elements||[]).filter(function(e){ return e.tags && e.tags.name; });
        fill('trails', my, found.map(fromRelation));
        return found.length;
      })
      .catch(function(){ return 0; });
  }

  function fromRelation(h){
    var c = h.center || {};
    return {kind:'route', label:h.tags.name, osm:{type:'R', id:h.id},
            lat:c.lat || 0, lon:c.lon || 0,
            sub:[h.tags.distance ? h.tags.distance+' km' : null,
                 h.tags.symbol || h.tags.network || 'hiking route'].filter(Boolean).join(' \u00b7 ')};
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
    dropTrailSearch();
    if(it.osm) loadOsm(it);
    else loadPlace(it.lat, it.lon, it.label);
  }

  /* Overpass mirrors go down, rate-limit and stall independently, and a stalled
     mirror answers no sooner than a dead one — waiting each one out in turn is
     what makes a picked trail look like it did nothing at all. So a mirror gets a
     few seconds to itself, then the next one races it, and the first answer wins;
     the losers are aborted so the volunteers aren't left doing unwanted work.
     Whichever answered is tried first next time. */
  var MIRRORS = ['https://overpass-api.de/api/interpreter',
                 'https://overpass.private.coffee/api/interpreter',
                 'https://overpass.kumi.systems/api/interpreter'];
  var mirror = 0;            // the one that answered last
  var HEDGE_MS = 5000;       // how long a mirror gets before the next one joins in
  var PATIENCE_MS = 22000;   // and how long the lot of them get in total

  function overpass(query, signal){
    return new Promise(function(resolve, reject){
      var open=[], started=0, failed=0, done=false, hedge=null;
      var patience = setTimeout(function(){ stop(new Error('Overpass timed out')); }, PATIENCE_MS);

      function settle(fn, v){
        if(done) return;
        done = true;
        clearTimeout(hedge); clearTimeout(patience);
        open.forEach(function(c){ c.abort(); });
        if(signal) signal.removeEventListener('abort', cancel);
        fn(v);
      }
      function stop(e){ settle(reject, e); }
      function cancel(){ stop(new Error('cancelled')); }
      if(signal){
        if(signal.aborted){ cancel(); return; }
        signal.addEventListener('abort', cancel);
      }

      function launch(){
        clearTimeout(hedge);
        if(done || started >= MIRRORS.length) return;
        var n = (mirror + started) % MIRRORS.length, ctl = new AbortController();
        started++; open.push(ctl);
        fetch(MIRRORS[n], {
          method:'POST', signal:ctl.signal, body:'data='+encodeURIComponent(query),
          headers:{'Content-Type':'application/x-www-form-urlencoded'}
        }).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
          .then(function(d){ mirror = n; settle(resolve, d); }, function(e){
            if(ctl.signal.aborted) return;          // called off on purpose, not a failure
            if(++failed >= MIRRORS.length) stop(e);
            else launch();
          });
        if(started < MIRRORS.length) hedge = setTimeout(launch, HEDGE_MS);
      }
      launch();
    });
  }

  /* ================= place mode ================= */

  var fc = null;

  /* `why` explains a fall back from a route to its location, and is left on
     screen once the forecast lands. */
  function loadPlace(lat, lon, label, why, retry){
    el.routeOpts.hidden = true;
    say('Fetching the forecast for '+label+'\u2026', 1);
    json('https://api.open-meteo.com/v1/forecast?timeformat=unixtime&timezone=auto&forecast_days='+DAYS+
         '&hourly=precipitation,wind_speed_10m&latitude='+lat.toFixed(4)+'&longitude='+lon.toFixed(4))
      .then(function(d){
        showPlace(d, label, why);
        if(retry) offer(retry.fn, retry.label);    // after showPlace has had its say
      }, function(){
        fail('Couldn\u2019t reach the forecast service. The sliders below still work.',
             function(){ loadPlace(lat, lon, label, why, retry); });
      });
  }

  function showPlace(d, label, why){
    var t=d.hourly.time, p=d.hourly.precipitation, w=d.hourly.wind_speed_10m;
    var off=d.utc_offset_seconds||0;
    var now=Date.now()/1000, i0=0;
    while(i0<t.length-1 && t[i0+1]<=now) i0++;
    fc = {t:t,p:p,w:w,off:off,i0:i0,label:label};

    /* The forecast is cut into local days from this hour on, so tomorrow and the
       days after it are a tap away instead of off the end of the strip. */
    var days=[], index={}, peak=0;
    for(var i=i0;i<t.length;i++){
      var key=dayOf(t[i],off);
      if(index[key]===undefined){ index[key]=days.length; days.push({key:key,from:i,to:i,mm:0}); }
      var day=days[index[key]];
      day.to=i; day.mm+=p[i]||0;
      if((p[i]||0)>peak) peak=p[i]||0;
    }
    fc.days=days; fc.today=days.length?days[0].key:0; fc.day=0;
    // One scale across every day, so a drizzle Tuesday can't look like a storm.
    fc.cap=Math.min(12, Math.max(2, peak));

    say(why); el.out.hidden=false; el.placeView.hidden=false; el.legs.hidden=true;

    var start=-1,end=-1;
    for(var j=i0;j<t.length;j++){ if(p[j]>=0.1){ start=j; break; } }
    if(start>-1){ end=start; while(end+1<t.length && p[end+1]>=0.1) end++; }

    if(start===-1){
      el.outHead.textContent='No rain forecast in '+label+
        (days.length>=7 ? ' all week.' : ' for the next '+days.length+' days.');
      el.outSub.textContent='Nothing to model \u2014 pick a day and tap an hour, or move the sliders by hand.';
      window.WetMetre.setRain(0, 1);         // nothing falling, and the sky above clears with it
    }else{
      var total=0; for(var k=start;k<=end;k++) total+=p[k];
      var hrs=end-start+1, when=dayOf(t[start],off);
      fc.day=index[when];                    // open on the day the rain is actually on
      el.outHead.textContent=(start===i0 ? 'Raining now'
          : 'Rain '+(when===fc.today ? '' : dayName(when,fc.today).toLowerCase()+' ')+
            'from '+hhmm(t[start],off))+
        ' \u2014 '+total.toFixed(1)+' mm over '+hrs+' hour'+(hrs>1?'s':'')+'.';
      el.outSub.textContent=label+' \u00b7 wind '+Math.round(w[start])+' km/h \u00b7 applied to the numbers above.';
      window.WetMetre.setRain(total, hrs);
    }
    drawDays(); drawHours();
  }

  function drawDays(){
    el.days.innerHTML = fc.days.map(function(d,i){
      return '<button class="day" data-d="'+i+'" aria-pressed="'+(i===fc.day)+'">'+
             '<b>'+esc(dayName(d.key, fc.today))+'</b>'+
             '<span class="day-mm'+(d.mm>=0.1?' wet':'')+'">'+
             (d.mm>=0.1 ? d.mm.toFixed(1)+' mm' : 'dry')+'</span></button>';
    }).join('');
  }

  function drawHours(){
    var d=fc.days[fc.day], html='';
    for(var i=d.from;i<=d.to;i++){
      var mm=fc.p[i]||0;
      var pct=Math.max(3, Math.min(100, mm/fc.cap*100));
      html+='<button class="hbar" data-i="'+i+'" data-wet="'+(mm>=0.1?'y':'n')+'" aria-pressed="false" '+
            'title="'+hhmm(fc.t[i],fc.off)+' \u2014 '+mm.toFixed(1)+' mm"><i style="height:'+pct+'%"></i></button>';
    }
    el.hours.innerHTML=html;
    // Today's strip starts at the current hour, so a late evening leaves too few
    // bars for three ticks to be three different times.
    var mid=Math.floor((d.from+d.to)/2), ticks=[d.from, mid, d.to].filter(function(i,n,a){
      return a.indexOf(i) === n;
    });
    el.hticks.innerHTML=ticks.map(function(i){
      return '<span>'+hhmm(fc.t[i],fc.off)+'</span>';
    }).join('');
  }

  el.days.addEventListener('click', function(e){
    var b=e.target.closest('.day'); if(!b||!fc) return;
    fc.day=+b.dataset.d;
    drawDays(); drawHours();
  });

  el.hours.addEventListener('click', function(e){
    var b=e.target.closest('.hbar'); if(!b||!fc) return;
    [].forEach.call(el.hours.querySelectorAll('.hbar'), function(x){ x.setAttribute('aria-pressed', x===b); });
    var i=+b.dataset.i, mm=fc.p[i]||0, key=dayOf(fc.t[i],fc.off);
    el.outHead.textContent=(key===fc.today ? '' : dayName(key,fc.today)+', ')+hhmm(fc.t[i],fc.off)+
      ' \u2014 '+mm.toFixed(1)+' mm in that hour.';
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

  function points(g){ return g.map(function(p){ return {lat:p.lat, lon:p.lon, ele:null}; }); }

  /* The line behind an OSM way or relation. An area outline or a stub of a few
     metres is not a walk, so both come back empty and are shown as a place. */
  function lineOf(e){
    if(e.type === 'relation'){
      var ways=(e.members||[]).filter(function(m){ return m.type==='way' && m.geometry && m.geometry.length>1; })
                              .map(function(m){ return points(m.geometry); });
      return ways.length ? stitch(ways) : [];
    }
    var line = e.geometry ? points(e.geometry) : [], a=line[0], b=line[line.length-1];
    if(line.length>2 && a.lat===b.lat && a.lon===b.lon) return [];    // a closed way is an outline
    return line;
  }

  function length(line){
    var m=0;
    for(var i=1;i<line.length;i++) m += dist(line[i-1], line[i]);
    return m;
  }

  var HIKING = '["route"~"hiking|foot|walking"]';
  var OSM_DOWN = 'OpenStreetMap didn\u2019t answer \u2014 here\u2019s the forecast for the spot. '+
                 'For the walk itself, try again in a minute or load the GPX.';

  /* A named path in OpenStreetMap is usually one segment of something much
     longer: search "Rennsteig" and the hit is a few hundred metres of track that
     happens to carry the name, not the 170 km of it. So when a way belongs to a
     waymarked route of the same name, that route is what gets walked. */
  function parentRoute(elements, name){
    var want = name.toLowerCase(), best = null;
    (elements||[]).forEach(function(e){
      var n = e.type === 'relation' && e.tags && e.tags.name;
      if(!n) return;
      var l = n.toLowerCase(), rank = l === want ? 2 : (l.indexOf(want) === 0 ? 1 : 0);
      if(rank && (!best || rank > best.rank)) best = {rank:rank, id:e.id, name:n};
    });
    return best;               // a route that merely passes through is not the one
  }

  /* Walk it if it is a line, stand on it if it is not: whatever goes wrong here,
     the forecast for the spot still beats "not found". */
  function loadOsm(it){
    var name = it.label;
    function instead(why){
      // Standing on the spot beats nothing, but the walk is still what was asked
      // for — so when OpenStreetMap is merely busy, the offer stays on screen.
      var retry = why === OSM_DOWN ? {fn:function(){ loadOsm(it); }, label:'Try the walk again'} : null;
      if(it.lat || it.lon) loadPlace(it.lat, it.lon, name, why, retry);
      else fail(why || 'That one has no geometry in OpenStreetMap.', retry && retry.fn);
    }
    function walk(label, line){
      if(length(line) < 250){
        instead('No walkable line for that one \u2014 here\u2019s the forecast where it is.');
        return;
      }
      runRoute(label, line);
    }
    function geometry(kind, id, label){
      say('Tracing \u201c'+label+'\u201d\u2026', 1);
      overpass('[out:json][timeout:60];'+kind+'('+id+');out geom;')
        .then(function(d){
          var e=(d.elements||[])[0];
          walk(label, e ? lineOf(e) : []);
        }, function(){ instead(OSM_DOWN); });
    }

    if(it.osm.type === 'N'){ instead(''); return; }
    say('Looking \u201c'+name+'\u201d up in OpenStreetMap\u2026', 1);

    if(it.osm.type === 'R'){ geometry('relation', it.osm.id, name); return; }

    // One call asks for the segment itself and the routes it belongs to, so the
    // common case — a way that is its own walk — costs no extra round trip.
    overpass('[out:json][timeout:30];way('+it.osm.id+')->.w;.w out geom;'+
             'rel(bw.w)'+HIKING+';out tags center;')
      .then(function(d){
        var els = d.elements || [], up = parentRoute(els, name);
        if(up){ geometry('relation', up.id, up.name); return; }
        var w = null;
        els.forEach(function(e){ if(e.type === 'way' && !w) w = e; });
        walk(name, w ? lineOf(w) : []);
      }, function(){ instead(OSM_DOWN); });
  }

  /* thin a route down to 100 evenly spaced nodes: enough for distance, ascent
     and a midpoint, coarse enough to shrug off GPS jitter, and exactly what
     Open-Meteo will take in one elevation call */
  var NODES = 100;

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

  /* GPX files usually carry their own elevations; OSM routes never do. Ask for
     more than NODES points here and Open-Meteo refuses the lot. */
  function elevations(nodes){
    if(nodes.every(function(p){ return p.ele != null; })) return Promise.resolve(nodes);
    var la=nodes.map(function(p){ return p.lat.toFixed(5); }).join(',');
    var lo=nodes.map(function(p){ return p.lon.toFixed(5); }).join(',');
    return json('https://api.open-meteo.com/v1/elevation?latitude='+la+'&longitude='+lo)
      .then(function(d){ (d.elevation||[]).forEach(function(e,i){ if(nodes[i]) nodes[i].ele=e; }); return nodes; })
      .catch(function(){ nodes.forEach(function(p){ if(p.ele==null) p.ele=0; }); return nodes; });
  }

  function runRoute(name, raw){
    el.routeOpts.hidden = false;
    if(!el.startAt.value) defaultStart();
    say('Measuring the route\u2026', 1);
    var t = thin(raw, NODES);
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
    }, function(){ fail('Couldn\u2019t measure that route.', function(){ runRoute(name, raw); }); });
  }

  var last = null;

  function forecastRoute(){
    if(!last) return;
    say('Fetching the forecast along the route\u2026', 1);
    // two-armed then: only the fetch is caught here, so a bug in showRoute
    // reaches the console instead of posing as a network failure
    json('https://api.open-meteo.com/v1/forecast?timeformat=unixtime&timezone=auto&forecast_days='+DAYS+
         '&hourly=precipitation,snowfall,wind_speed_10m&latitude='+last.mid.lat.toFixed(4)+
         '&longitude='+last.mid.lon.toFixed(4))
      .then(showRoute, function(){
        fail('Couldn\u2019t reach the forecast service. The route measured fine.', forecastRoute);
      });
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

    var vTop=0, vFront=0, snow=0, gap=0, rows=[], cover=W.cover(), mmh=0, walked=0;
    for(var i=0;i<t.length;i++){
      var hs=t[i], he=hs+3600;
      var a=Math.max(t0,hs), b=Math.min(t1,he);
      if(b<=a) continue;
      var dt=b-a;
      var v=W.compute(p[i]||0, dt, speed, cover);
      vTop+=v.top; vFront+=v.front;
      snow=Math.max(snow, s[i]||0);
      mmh+=(p[i]||0)*dt/3600; walked+=dt;
      rows.push({t:hs, mm:p[i]||0, wind:w[i]||0, l:(v.top+v.front)*1000,
                 d0:(a-t0)*speed, d1:(b-t0)*speed});
    }
    var covered=rows.reduce(function(n,r){ return n+(r.d1-r.d0); },0);
    gap=last.total-covered;

    W.paint(vTop, vFront);
    W.setRainRate(walked ? mmh/(walked/3600) : 0);   // the sky shows the walk's own rain
    el.out.hidden=false; el.placeView.hidden=true; el.legs.hidden=false;

    var hh=Math.floor(hours), mm=Math.round((hours-hh)*60);
    el.outHead.textContent=last.name;
    el.outSub.textContent=km.toFixed(1)+' km \u00b7 '+Math.round(last.gain)+' m up \u00b7 about '+
      hh+'h '+pad(mm)+' at '+(speed*3.6).toFixed(1)+' km/h average';

    var wettest=null;
    rows.forEach(function(r){ if(!wettest||r.l>wettest.l) wettest=r; });
    // A long day out now runs past midnight more often than not, so the hours
    // are broken up by the day they fall on.
    var day0 = dayOf(Math.floor(Date.now()/1000), off), seen = -1;
    el.legs.innerHTML = rows.length ? rows.map(function(r){
      var hot = wettest && r.t===wettest.t && r.l>0.02;
      var key = dayOf(r.t, off), head = '';
      if(key !== seen){
        seen = key;
        head = '<div class="leg-day">'+esc(dayName(key, day0))+'</div>';
      }
      return head+'<div class="leg'+(hot?' leg-hot':'')+'">'+
             '<span class="leg-t">'+hhmm(r.t,off)+'</span>'+
             '<span class="leg-d">km '+(r.d0/1000).toFixed(1)+'\u2013'+(r.d1/1000).toFixed(1)+'</span>'+
             '<span class="leg-r">'+r.mm.toFixed(1)+' mm/h</span>'+
             '<span class="leg-l">'+(r.l<0.01?'\u2014':r.l.toFixed(2)+' L')+'</span></div>';
    }).join('') : '<p class="hint">This walk falls outside the forecast window.</p>';

    var notes=[];
    if(snow>0.1) notes.push('Snow forecast here \u2014 the litres are an upper bound on wetness and mostly a warning about cold.');
    if(gap>100) notes.push('The forecast reaches '+DAYS+' days out; the last '+(gap/1000).toFixed(1)+' km falls beyond it and counts as dry.');
    if(wettest && wettest.l>0.02) notes.push('Wettest stretch: km '+(wettest.d0/1000).toFixed(1)+'\u2013'+
      (wettest.d1/1000).toFixed(1)+' from '+hhmm(wettest.t,off)+'.');
    say(notes.join(' '));
  }

  /* ================= inputs ================= */

  el.gpx.addEventListener('change', function(e){
    var f=e.target.files && e.target.files[0];
    if(!f) return;
    say('Reading '+f.name+'\u2026', 1);
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

  function stamp(d){
    return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  }
  function defaultStart(){
    var d=new Date(Date.now()+3600000); d.setMinutes(0,0,0);
    el.startAt.value=stamp(d);
    // The picker stops where the forecast does, rather than at a silent zero.
    var min=new Date(); min.setMinutes(0,0,0);
    el.startAt.min=stamp(min);
    el.startAt.max=stamp(new Date(min.getTime()+(DAYS-1)*86400000));
  }
  defaultStart();

})();
