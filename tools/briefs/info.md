# Brief: country summaries

You write short country profiles for a personal app that teaches flags and capitals.
The reader is a curious, well-educated adult. Tapping a country on the map shows your text
under the flag, so it should read in about 30 seconds.

Input: `data/info/todo-N.json` — `[{id, name, capital, sovereign}]`.
Output: `data/info/part-N.json` — one object keyed by id, in the same order:

```json
{
  "fr": {
    "about": "One paragraph, 60–100 words: where it is, what kind of country it is (size, population order of magnitude, language(s), government in a few words), and the big arc of its history.",
    "dates": [["1789", "French Revolution begins"], ["1958", "Fifth Republic founded"]],
    "known": ["Eiffel Tower and Louvre", "Wine, cheese and haute cuisine", "Tour de France"]
  }
}
```

Rules
- `about`: a single paragraph (two only if truly needed), max ~100 words, plain prose, no
  bullet characters, no markdown. Use English common names.
- `dates`: 3–6 entries, chronological. The most important turning points (founding,
  independence, unification, revolutions, wars, major regime changes, EU/union entry…).
  Year strings may be "c. 3100 BC", "1066", "1990s". Event text ≤ 8 words.
- `known`: 3–5 short items (≤ 8 words each): what it's famous for — landmarks, food,
  culture, sport, people, natural features, economy.
- Territories (`sovereign: false`): say whose territory it is and its status in `about`.
- Be accurate. Only state facts you are confident about; if unsure about a detail, leave it
  out rather than guess. Prefer round population figures ("about 68 million"). Neutral
  tone on disputed topics (Taiwan, Kosovo, Palestine, Western Sahara, Cyprus…): state the
  dispute plainly without taking sides.
- No web lookups needed; write from knowledge. Write the file with one Write call (or a
  few if long), then validate it with
  `node -e "const o=require('./data/info/part-N.json');console.log(Object.keys(o).length)"`
  and check the count equals the todo file's length and every entry has all three fields.
- Only create `data/info/part-N.json`. Do not touch any other file.
