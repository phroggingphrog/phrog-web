# Personal discovery: statistical preference model (Phase 2c)

Owner, 2026-10-26: "basically we will translate this into a stats model to based the feedback into preferences".

The model turns what the owner did and said into a probability that they like each thing (an author, a topic, a venue, ...), with an honest uncertainty. It is a plain Beta-Binomial model: no sampling, no dependencies. Code: `src/personalization/stats/` (`beta.ts`, `model.ts`, `evaluate.ts`). Method background: the `applied-bayesian-reasoning` skill (conjugate prior, shrinkage, credible interval, posterior predictive check by held-out scoring).

## 1. What is estimated

One estimate per `(subject_type, subject_key, horizon)`. The estimate is the probability that the owner reacts positively to an item of that subject.

| subject_type | key | comes from |
| --- | --- | --- |
| `ig_author` | lowercase handle | Instagram posts (creator item, else author handle) |
| `music_artist` | lowercase artist | Spotify and Apple Music tracks |
| `rss_source` | feed title | RSS items |
| `topic` | hashtag, or the topic the owner named in feedback | `items.hashtags_json`, feedback `scope=topic` |
| `venue` | lowercase venue text | events (`event_details.venue_text`) |
| `event_category` | e.g. `gigs`, `film` | events (`event_details.category`) |
| `place_category` | the saved-places list name | Google Maps saves |

Horizons: `long` (all evidence, equal weight) and `recent` (exponential decay, half-life 90 days, `PHROG_STATS_HALF_LIFE_DAYS`). Decay is measured back from the newest observation of the same source, so a stale export is not all zero.

## 2. Evidence

Each piece of evidence adds a weight to a success count `s` or a failure count `f` of every subject it touches. All weights are in `DEFAULT_CONFIG` (`stats/model.ts`) and are stored with every run in `preference_model_runs.config_json`.

| evidence | success | failure |
| --- | --- | --- |
| explicit feedback `like`, `save`, `want_to_go` (lasting scope: item, creator, topic, venue) | 1.0 | |
| explicit feedback `dislike` (lasting scope) | | 1.0 |
| imported or live behaviour: like, save, comment, share (`learn=1`) | 0.5 | |
| music play | 0.2 | |
| music skip | | 0.2 |
| imported `not_interested` or `dislike` | | 0.5 |
| saved place | 0.5 | |
| shown to the owner and left without any action | | 0.05 |

Which subjects an item touches: scope `item` touches all of its subjects (author, venue, category, hashtags); scope `creator` only the author; `venue` only the venue; `topic` only the topic named in the reason.

Never evidence:

- `this_time` scoped feedback and `not_now`, `too_far`, `too_expensive`. They do not change lasting taste. (The plan allows a separate per-context constraint for these; it is not built, so today they have no effect on the model at all.)
- Hermes `agent_decisions`. They are the agent's guesses; learning from them would be learning from itself.
- Anything unseen. The 0.05 failure applies only to (a) `seen_in_feed` observations that are not sponsored and whose item has no positive action and no feedback, and (b) deliveries with `displayed_at` set and no feedback. Returned-but-not-displayed deliveries and items with no observation add nothing.
- Observations with `learn=0`, and actions that are not in the table (open, search, post, ad views).

Caveat: a `seen_in_feed` row means the item came through the feed session, not that the owner personally looked at it. The weight is small (0.05) for that reason.

### Per-source normalisation

A prolific source must not dominate. For each (subject, source) the evidence mass `s + f` is capped at `sourceCap` (default 30, `PHROG_STATS_SOURCE_CAP`); above the cap both counts are scaled down so the success/failure ratio is kept. Sources are separate: `spotify`, `apple_music`, `instagram`, `instagram_live` (feed observations), `rss_live`, `owner_feedback`, `discover`, `saved_places`. An artist with 5,000 plays gets the same weight as one with about 150 (at 0.2 each). Different subject types are never mixed; each has its own prior.

## 3. The model

For a subject with weighted successes `S` and failures `F` (after the cap):

    prior      theta ~ Beta(a0, b0)
    posterior  theta | data ~ Beta(a0 + S, b0 + F)
    mean       (a0 + S) / (a0 + b0 + S + F)
    n_eff      S + F
    90% CI     the 5% and 95% quantiles of the posterior

Weights are fractional, so this is a weighted-pseudo-count version of the Beta-Binomial; the posterior is exact for integer weights and a standard approximation otherwise.

**Shrinkage.** One like (0.5) moves a Beta(1,1) subject from 0.50 to 0.60 with a wide interval; fifty likes (capped at mass 30) give mean about 0.97 and a lower bound above 0.85. Sparse subjects stay near their type mean.

**Empirical-Bayes prior per subject type.** From the long-horizon rates `p_i = S_i/(S_i+F_i)` of subjects with mass at least 3, using at least 8 such subjects:

    m = mean(p_i),  v = var(p_i),  q = m(1-m),  r = mean(1/n_i)
    kappa = (q - v) / (v - q r)          # a0 + b0, clamped to [1, 50]; 50 if v <= q r
    a0 = m kappa,  b0 = (1 - m) kappa

If there are too few subjects, if `m` is outside (0.1, 0.9), or if the spread is impossible (v >= q), the prior is the fallback Beta(1,1) (strength 2). The `recent` horizon uses the same prior as `long`. The fitted priors are saved per run (`priors_json`).

**Credible interval.** `beta.ts` computes the regularised incomplete beta function (continued fraction) and inverts it with a safeguarded Newton step. Tests compare it with closed forms (Beta(1,b), Beta(a,1), arcsine, 3x^2-2x^3) and a published Beta(2,5) value, and round-trip it over a grid.

## 4. Storage

`006_stats_model` adds to `preferences`: `alpha, beta, mean, ci_low, ci_high, n_eff, model_version`. `score` holds the mean, `evidence_count` the raw count, `distinct_days` as before. The table is rebuilt from scratch on every rebuild (no history), deterministic for fixed inputs. `preference_model_runs` has one row per rebuild: `model_version`, `computed_at`, `inputs_cutoff` (newest evidence time), `config_json`, `counts_json` (subjects per type and horizon, evidence rows per source, newest time per source), `priors_json`, `runtime_ms`. It also adds an index on `item_ids(item_id)`.

Rebuild: `phrog-web personal preferences --rebuild`, MCP `personal_preferences` with `rebuild`, and automatically at the start of every `personal_discover`.

## 5. Use in ranking

For an item, the matched subjects are its author, venue, event category, hashtags, and any stored topic whose key appears in its title or description. `stats_score` is the mean of the matched subjects' values weighted by long-horizon `n_eff` (null when none match). A subject's value is `0.6 * long mean + 0.4 * recent mean` when a recent estimate exists. The interval bounds are averaged the same way; that average is a heuristic, not an exact interval for the combination.

**Discover** (`discover.v1`): the existing Jev part is `0.7 p_match + 0.3 p_engage` (0.25 when unscored). Rank score:

    stats present:  0.6 * jev_part + 0.4 * stats_score
    stats absent:   jev_part

then the existing `prefer` / `avoid` / liked-something-similar / unknown-date adjustments. Explicit `exclude` rules and lasting dislikes still drop an item before ranking, so they always win. Each item has `stats: {score, matched: [{subject_type, key, mean, ci}]}` and a "your history" reason.

**Feed filter** (`feed.v1`): the Jev threshold on `p_match` is unchanged unless the stats are confident:

- `ci_low > 0.7`: pass, reason `stats_confident_pass`, even below the threshold or with no text.
- `ci_high < 0.2`: fail, reason `stats_confident_fail`, even if Jev would pass it.

Otherwise the usual threshold, no-text and error rules apply. `--order predicted` sorts by the same blend. `prediction.stats` is set whenever any subject matched; if there is no Jev score, `prediction` has `scorer: "stats"` and null Jev fields. Jev is still called for every post (so its scores keep being recorded for evaluation); the feed has no explicit rules to override.

**Jev's preference summary** is built from the posteriors: per type, subjects whose lower bound is above the type's prior mean ("clearly likes", long and, for authors and artists, recent), then confident dislikes (upper bound below the prior mean; music artists and places are left out because skips are not dislikes). Names and rates only, at most 2,500 characters.

## 6. Evaluation

`phrog-web personal evaluate [--json]` (counts and scores only, no contents):

- Labels, one per item: explicit feedback (like/save/want_to_go positive; lasting dislike negative), imported Instagram likes and saves (positive), feed items seen without any action (negative). Positive wins.
- Split by label time: fit on evidence strictly before the 70th-percentile label time, score the later labels.
- Methods: type-prior baseline (the typical rate of the subject types the item matches), stats model, and Jev `p_match` where a stored prediction exists. Brier score and log loss, plus the stats model and baseline on exactly the Jev-scored items, an explicit-feedback-only line, and five calibration buckets.
- Small samples (under 30) and one-sided label sets are reported as such.

## 7. Known limits

- Real labels are almost all positive (imports are likes). The negative class is only 54 "seen without action" feed items, all from one day, so Brier and log loss mostly reflect the base rate and calibration is weak. A constant "always likely" predictor would score well. More explicit dislikes and displayed-without-reaction events will fix this over time.
- Instagram authors have only positive evidence, so the prior falls back to Beta(1,1); the estimate says how much the owner likes an author relative to 0.5, not relative to authors never seen.
- Topics are thin: few posts have hashtags, and there are no stored topic annotations yet.
- No per-context constraint for `this_time` feedback.
- A full rebuild reads about 390k behaviour rows and takes a few seconds; `personal_discover` runs it every time.
