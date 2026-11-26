# Koi home page

A live ASCII home page with a clock, four clickable spots for your most used sites, and five
scenes to pick from, each in a light and a dark version. Built on
[ascii-life-engine](https://github.com/howdeploy/ascii-life-engine) (`ascii-life.js`, used unmodified;
the rat and jellyfish scenes live in their own files, `rats.js` and `jellies.js`, and plug into the engine from outside).

## Tuning the animals (the gear)

Click the gear in the top-right corner to open a small panel for the scene you are on. Press Escape or
click anywhere else to close it. Each scene remembers its own settings in that browser, and
"reset this scene" puts it back.

| Slider | What it does |
|---|---|
| Size | Makes the animals bigger or smaller, live (frogs stop at x1.25 so the pads don't bury the clock) |
| Speed | How fast everything moves |
| Movement (calm to lively) | Calm: slower, longer pauses, gentler. Lively: quicker, longer-lasting ripples and wakes, and for the rats and jellyfish more energy (more darting and sniffing breaks for rats, quicker and stronger pulses for jellyfish) |
| Hue | Rotates every colour around the colour wheel, from -180 to +180 degrees. It tints the whole animal layer, so in the koi and frog scenes the water changes colour too |

Hue is a screen tint, so it shifts the colours you see, not the named palettes. For a fixed set of coats
or colours, use the `palette` setting described in each scene's section.

## Scenes and dark mode

Use the small switcher at the bottom of the page.

| Scene | What you get |
|---|---|
| Koi | Nine koi in a pond, a bit smaller than the engine default |
| Frogs | Lily pads with frogs hopping from pad to pad |
| Butterflies | Blue and pink butterflies flying through a starry night sky |
| Jellyfish | Nine jellyfish drifting through deep water: pink/purple, blue and yellow (see below) |
| Rats | Nine rats scurrying over a dusky floor: white, gray, brown, and three calico coats (see below) |

- **Dark / Light** button: the same scenes after dark (moonlit water for koi and frogs, a darker sky
  for the butterflies, a darker floor for the rats).
- Keys: `S` cycles scenes, `D` toggles dark, `1` `2` `3` `4` open your four sites.
- Your choice is remembered. To force one, add `?scene=koi|frog|butterfly|rat|jelly&theme=dark|light` to the address.
- Click the scene to scare the animals, move the pointer near them and they swim, hop, fly or scurry away.

## The jellyfish

Side-on jellyfish in three colours (pink/purple, blue, yellow, three of each by default). They move the
way real ones do: the bell squeezes quickly, which shoves the body forward, then refills slowly while the
jellyfish glides and sinks a little, so they travel in soft surges. The tentacles and frilly oral arms
are dragged through the water behind the bell: they stream out on a surge, bunch up on a pulse, sway side
to side, and swing wide when the jellyfish turns. Move the pointer near one and it pulses faster to get
away; click and nearby ones get a shock and a flash.

To use a single colour, change `palette: 'mix'` in the `jelly` scene in `index.html` to `'orchid'`
(purple rim, pink bell), `'pink'`, `'purple'`, `'blue'` or `'yellow'`. How they move is tuned by the
constants at the top of `jellies.js`: `PUSH` (how hard a pulse shoves), `DRAG` (lower = longer glides),
`SINK`, and `SQUEEZE` (share of each pulse spent squeezing).

## The rats

Top-down rats that run in short bursts, stop to sniff (whiskers twitching), and bolt when the pointer
comes near. The tail is a long, tapered S that ripples as they move and sways wider when they run, and the legs keep pace with the ground speed.

The default `mix` shows all six coats at once, shuffled so each one appears:

| Palette | Coat |
|---|---|
| `white` | plain white, ruby eyes |
| `gray` | plain gray |
| `brown` | plain brown |
| `calico` | white with gray patches |
| `brownCalico` | white with brown patches |
| `tricolor` | white with gray and brown patches |

Every calico rat gets its own patches: usually a hood over the head, sometimes a stripe down the back,
and a few blobs along the body. To use just one coat, change `palette: 'mix'` in the `rat` scene in
`index.html` (for example `palette: 'brownCalico'`). `count` and `size` work the same as for the koi.

## Your four links

Hover a tile and click **edit** (on a phone the button is always faintly visible), or click a **+** tile
to add one. Paste an address such as `pinterest.com`, optionally give it a name, and save. You can also
remove a link, and "reset all links" at the bottom of the panel returns to the list in the file.
Changes are saved in that browser only (they do not travel to other browsers or computers).

**Icons come from the link itself.** For each site the page tries, in order: a large icon from Google's
favicon service, the site's own `/favicon.ico`, then DuckDuckGo's icon service. If none loads you get a
two-letter tile. Icons sit on a light plate so dark logos stay visible. Icon lookups need an internet
connection; the services only see the site's address.

To change what a fresh browser starts with, edit the `LINKS` list near the top of the script in
`index.html` (use `null` for an empty slot):

```js
var LINKS = [
  { name: 'Gmail',     url: 'https://mail.google.com/',   accent: '#e8553f' },
  { name: 'YouTube',   url: 'https://www.youtube.com/',   accent: '#e6b94a' },
  { name: 'Pinterest', url: 'https://www.pinterest.com/', accent: '#f1e8d8' },
  null
];
```

- `name` is the label (optional; taken from the address if left out).
- `url` is where it goes.
- `accent` is the colour of the tile corners.
- `icon` (optional) is your own image, for example `icon: 'icons/mail.png'`, used instead of the lookup.
- Set `CLOCK_24H = true` for a 24-hour clock.

## Tune the scenes

The scene settings are in the `SCENES` block of `index.html`. The koi count and size are
`count: 9` and `size: 0.8`; frogs and rats use the same `size`, and the rats use `count: 9` too.
Lower `size` for smaller animals. The look of the rats themselves (coat colours, body shape, how fast
they run) is in `rats.js`; the tail shape is the `TAIL_*` constants at the top (`TAIL_WAVES`, `TAIL_SWAY`, `TAIL_RUN`).

`GRID_COLS = 300` sets how fine the grid is (how many cells across the screen). 300 gives sharp
animals but the most work per frame, and the frog scene is the heaviest. If the animation stutters on
your computer, lower it to `220` (still fine, much lighter) or `150` (the chunky original look).

## Use it as your Chrome home page

1. Keep `index.html`, `ascii-life.js`, `rats.js` and `jellies.js` together in one folder.
2. Chrome → Settings → Appearance → turn on **Show home button** → **Enter custom web address**.
3. Paste the file address of `index.html`, for example `file:///Users/you/koi-home/index.html`
   (Windows: `file:///C:/Users/you/koi-home/index.html`).
4. Optional: Settings → On startup → **Open a specific page** → add the same address.

You can also host the folder on GitHub Pages and use that URL instead.

Chrome does not let a plain web page replace the New Tab page; that needs a small extension.
