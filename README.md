# Tough Crowd

A comedy-club party game for 3 to 10 phones, with an optional big screen.
Answer each prompt by writing something funny or by playing a card from
your hand. The room decides what's funny.

Live at **https://play.jadon.me/crowd/** · big screen at **/crowd/?tv**

## The show

Three acts. The host can switch any of them off in the lobby.

| Act | How it works | Points |
| --- | --- | --- |
| **I. Head to Head** | Everyone gets two prompts, each shared with a different rival. Write an answer or play a card. Each duel goes up anonymously and everyone else votes. | 600 split by vote share, +100 for the win, +200 more if you sweep every vote ("Killed it!") |
| **II. The Hot Seat** | One player judges a prompt about themselves ("Sam's worst habit, in five words or fewer"). Everyone else answers. The judge picks a favourite, then guesses who wrote it. The others can add crowd votes. | 400 for the judge's pick, 200 split by crowd votes, 200 to the judge for guessing the writer |
| **III. The Closer** | One last prompt for everyone. Give your mic to one answer and, if you like, throw a tomato at another. Answers are revealed from the fewest mics to the most. | 1,500 split by mic share, +250 for the top answer |

- **Answers:** write or play a card (default), cards only, or write only.
- **Your hand:** six cards. A played card is replaced at once, and you can swap the whole hand once per act. If time runs out, a random card from your hand gets played for you, so nobody ever submits a blank.
- **Pace:** relaxed, normal or quick.
- **Family filter:** bleeps swearing in written answers. Slurs are always masked.
- **The audience:** anyone who joins mid-game, or after ten players, can still vote and react. They get a seat in the next game.
- **The Hot Seat with more than six players:** the top six on the leaderboard judge, which gives everyone else a chance to catch up.
- End-of-show awards include Showstopper, Mind Reader, Judge's Pet, Card Shark, Golden Pen, Tomato Magnet, Crowd Favourite and Tough Crowd.

All 180 duel prompts, 62 Hot Seat prompts, 42 Closer prompts and 363 cards were written for this game. They're in [`game/content.js`](game/content.js).

## The big screen (`?tv`)

Open `/crowd/?tv` on a TV or laptop. It shows the room code and a QR code,
reads the prompts and answers aloud with the browser's speech voice, plays a
little walking-bass lounge loop while everyone writes, and handles every
reveal: vote chips, stamps, splats and confetti. All the audio is
synthesised with Web Audio. There are no sound files. Sound, music and the
host voice can each be switched off from the controls in the bottom corner.

## Running it

```
npm install
npm start              # http://localhost:3160
```

`PORT` and `HOST` are read from the environment. The client opens its
WebSocket at its own directory, so it works under a sub-path like `/crowd/`.

## Code

- `game/engine.js`: all the rules. It's pure, with an injected clock and presence, so tests can drive whole games.
- `game/content.js`: every prompt and card.
- `game/filter.js`: text clean-up, slur masking and the family filter.
- `server.js`: static files, rooms, reconnects (a token in localStorage), host hand-off, rate limits, server-side bots (dev only), and a personalised view of the game sent to each client.
- `public/js/phone.js` / `tv.js`: the two clients. `ui.js` holds the shared pieces, `audio.js` the synth, `voice.js` the speech.

## Testing

```
npm test                  # engine tests (360 random games) + headless WebSocket sim
node test/bots.js CODE 4  # fill a real room with 4 scripted phones
```

Add `?dev` to the phone URL to get an "Add a bot" button in the lobby and
`window.__tc` for poking at state. Add `&ns=a` / `&ns=b` to run several
phones in one browser.
