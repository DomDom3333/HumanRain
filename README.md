# HumanRain

Converts rainfall in millimetres into something a person can picture: glasses of
water tipped over your head.

"1.3 mm of rain" tells you nothing about whether to take a coat. This works out
how much water actually lands on **you**, given how long you're outside, how fast
you're moving, and whether you've got an umbrella — then shows it in a vessel you
can picture.

Three files, no build step, no dependencies, no API key. Point it at a town for the
next rain window, or at a walking route for the weather you'll actually walk into.

## Units

The number stays human by changing the container rather than the digits. Every
unit is a physical object with a settled size that you own — no "splashes" or
"handfuls", which describe an event rather than a volume:

| Vessel  | Volume | Typical case |
|---------|--------|--------------|
| Eggcup  | 50 ml  | Dash to the car |
| Glass   | 250 ml | Ten minutes in light rain |
| Bottle  | 1.5 L  | An hour's walk in moderate rain |
| Bucket  | 10 L   | A long day out in the wet |
| Bathtub | 150 L  | Eight hours in an alpine downpour |

The largest vessel you'd need at least ~0.8 of is chosen automatically, keeping the
count between roughly 1 and 10 across four orders of magnitude. Chips under the
readout pin it to one unit instead — useful for comparing two forecasts that would
otherwise be measured in different things.

Each step is a 5–7× jump, so no two units compete to describe the same amount. The
volume is always printed beside the count, since a "bottle" means different things
to different people and the label removes the doubt.

## The maths

One millimetre of rain is one litre per square metre. Two things get you wet:

**What lands on you.** Standing still, you catch rain on your horizontal profile
— head, shoulders, upper arms — about `0.10 m²` for an adult.

```
V_top = A_top × rate × time
```

**What you walk into.** Rain hangs in the air at a volume concentration of
`rate ÷ fall_speed`, taking raindrop terminal velocity as ~6 m/s. Your front
(~`0.65 m²`) sweeps through that column.

```
V_front = A_front × speed × time × (rate ÷ 6)
```

The second term scales with *distance covered*, not time — which is why running
through rain gets you less wet overall, but soaks your front faster. In anything
above a stroll it dominates: most of the water on you is water you drove into.

Cover is modelled crudely. An umbrella removes the top term and halves the front;
a hood covers about two thirds of the top and shaves a little off the front.

A full outfit holds roughly 1.5 litres before it starts dripping, which is where
the readout switches from "soaked" to "wet through".

### Known limitations

- **Wind isn't in the model.** It's fetched and displayed, but not applied. Doing
  it properly means replacing the fixed 6 m/s vertical fall with a slanted rain
  vector, which increases the effective frontal sweep and tilts water in under an
  umbrella. This is the biggest single source of error and the most worthwhile
  next change.
- Body areas are one fixed adult. No height or build input.
- Drop size, clothing absorbency, and spray off the ground are all ignored.
- It's for intuition, not for court.

## Routes

A walk isn't a location — you're at km 4 at 10:30 and km 12 at 14:00, and the rain
isn't the same at either. Feed the tool a route and it walks you through the
forecast hour by hour.

1. **Load a route** — a GPX file, or pick a trail from the search box.
2. **Measure it.** The route is thinned to ~120 evenly spaced nodes, which is
   plenty for distance and ascent and coarse enough to shrug off GPS jitter.
   Missing elevation is backfilled from Open-Meteo's elevation endpoint.
3. **Average pace from [Naismith's rule][naismith]:** an hour per 5 km, plus an
   hour per 600 m of ascent, scaled by the pace setting. A 12 km walk with 800 m
   of climb comes out at 3h44 — an average of 3.2 km/h.
4. **One forecast point**, at the route's midpoint.
5. **Integrate hour by hour** at that average speed, so a walk that starts dry and
   hits rain at hour three is scored as exactly that.

Results break down per hour with the wettest stretch called out — which is the
question that matters. Not *will it rain*, but *will it rain while I'm on the
exposed ridge*.

One consequence worth noting: slow walks put a **larger** share of the water on
your head and shoulders, because only the frontal term scales with speed. On that
alpine walk the head share is 51%; on a flat towpath at 5 km/h it drops to 40%.
Which also means an umbrella is worth more on a climb than on the flat.

[naismith]: https://en.wikipedia.org/wiki/Naismith%27s_rule

### Where route data comes from

**bergfex has no public API.** The integrations that exist scrape the website,
which a browser app can't do (CORS) and which breaks whenever bergfex changes its
markup. So bergfex is supported the way every tour site is: download the tour's
GPX and load the file. That also covers Komoot, Outdooractive, AllTrails, Strava
and GPS watches.

**Trail search** uses the [Overpass API][overpass] against OpenStreetMap
`route=hiking` relations — the same data behind [Waymarked Trails][wmt]. Relation
members arrive as unordered ways and are stitched by endpoint matching with a 60 m
tolerance; genuinely disconnected routes are rejected rather than silently
mis-measured.

[overpass]: https://wiki.openstreetmap.org/wiki/Overpass_API
[wmt]: https://waymarkedtrails.org

### Route limitations

- **One average speed for the whole walk.** A route that front-loads its climbing
  is scored as though the ascent were spread evenly, so the km ranges per hour
  drift from reality even when the total is right.
- **One forecast point.** Fine for a day walk, coarse for a route crossing a range.
- **Snow is flagged, not modelled.** If snowfall is forecast the litres are an
  upper bound on wetness and mainly a warning about cold.
- Naismith models terrain, not fatigue, packs, rests or navigation, and runs
  optimistic on long days.
- Exposure isn't modelled — forest and open ridge are treated identically.
- Forecasts reach three days out; anything beyond counts as dry and says so.

## Forecast data

Uses [Open-Meteo](https://open-meteo.com) — free, no API key, CORS-enabled:

- `geocoding-api.open-meteo.com/v1/search` turns a place name into coordinates
- `api.open-meteo.com/v1/forecast` returns hourly `precipitation` and
  `wind_speed_10m`

One search box covers both. Place names come from Open-Meteo's geocoder as you
type; trail names are queried from Overpass on a longer debounce, since it
rate-limits hard and a keystroke-by-keystroke query would be abusive. Coordinates
typed directly are recognised without any lookup at all.

For a place, the app finds the next contiguous block of hours with ≥ 0.1 mm and
feeds the total and its duration into the model. The hourly strip lets you pick a
single hour instead.

Times are requested as `timeformat=unixtime` with `timezone=auto`, so hour labels
are rendered in the *location's* local time rather than the viewer's.

If you embed this somewhere with a restrictive Content-Security-Policy, the fetch
will fail and the app says so — the manual sliders keep working.

## Using it

Search a town or trail and everything is filled in for you. Three controls then
matter: how long you're out, how you're moving, and what you're wearing. The
rainfall sliders are tucked into a "Set the rain by hand" disclosure for when you
have a figure from elsewhere and no location to look up.

## Running it

Open `index.html`. That's it — though trail mode wants a real origin rather than
`file://`, so use the local server below.

To serve locally:

```bash
python3 -m http.server 8000
```

To publish: push to GitHub, then Settings → Pages → deploy from `main` / root.

## Licence

[GNU AGPL v3](LICENSE) or later.

The AGPL is deliberate rather than habitual. HumanRain is a web app, and section
13 of the AGPL closes the gap the GPL leaves open: if you run a modified version
on a public server, you must offer your users the modified source. Ordinary
copyleft only triggers on *distribution*, and hosting a web app isn't
distribution — so under the GPL or MIT, someone could take this, improve it, and
serve it to the world with nothing given back.

Practically, that means: fork it, change it, host it, charge for it if you like —
but the people using your version must be able to get your source. The footer
carries the source link that makes that offer real, which is exactly what the
FSF recommends for web applications. If you fork this, **point that link at your
own repository** — otherwise you're offering my source in place of yours, and
you haven't complied.

Third-party data has its own terms: weather and elevation from
[Open-Meteo](https://open-meteo.com) (CC BY 4.0), trail geometry from
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
Both are attributed in the page footer; keep that attribution.
