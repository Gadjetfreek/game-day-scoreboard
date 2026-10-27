# Game Day Scoreboard

A live, mobile-first sports scoreboard inspired by sports score apps. The home screen shows a grid of six games; tap one to see the live scoreboard, current drive with a field-position graphic, recent plays, team stats, and scoring plays.

- Leagues: College Football, NFL, NBA, NHL, MLB
- Pick which game fills each of the six squares (saved on your device)
- Auto-refreshes: grid every 25s, open game every 15s
- Back button and browser/swipe back on every game screen

## How it works
Plain HTML, CSS, and JavaScript with no build step. The browser pulls ESPN's public scoreboard and game summary JSON feeds directly. `proxy.php` is an optional fallback relay for PHP hosting in case direct requests fail.

Note: ESPN's feeds are unofficial and can change without notice.

## Run it
Open `index.html` through any static web server, for example:

```
python3 -m http.server 8000
```

Then visit http://localhost:8000.
