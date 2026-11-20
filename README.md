# Kijklijst

Eén overzicht van waar de titels op mijn IMDb-watchlist te streamen zijn, met tips op basis van wat ik al zag.

## Hoe het werkt

Vier keer per dag draait de taak **Kijklijst verversen** (GitHub Actions). Die taak:

1. leest de openbare IMDb-watchlist en de beoordelingen van het profiel uit `config.json`;
2. zoekt elke titel op bij TMDB en haalt daar de filmgegevens en het streamingaanbod (JustWatch) op;
3. stelt tips samen uit titels die verwant zijn aan hoog beoordeelde films en de watchlist;
4. bewaart het resultaat in `site/data/data.json` en publiceert de map `site/` via GitHub Pages.

De app zelf (`site/index.html`) leest alleen dat ene gegevensbestand. Welke diensten "van mij" zijn wordt per apparaat in de browser onthouden; `services` in `config.json` is de standaardkeuze voor een nieuw apparaat.

## Eenmalig instellen

1. **IMDb**: zet je watchlist op openbaar en vul in `config.json` bij `imdbUser` het adres van je profiel in.
2. **TMDB-sleutel**: Settings → Secrets and variables → Actions → New repository secret, naam `TMDB_API_KEY`.
3. **Publicatie**: Settings → Pages → Source: **GitHub Actions**.
4. Start de taak één keer met de hand: Actions → Kijklijst verversen → Run workflow.

## config.json

| Veld | Betekenis |
| --- | --- |
| `imdbUser` | Adres of id van je IMDb-profiel (`ur…` of `p.…`) |
| `region` | Land waarvoor het aanbod wordt opgehaald, bijvoorbeeld `NL` |
| `language` | Taal van beschrijvingen, bijvoorbeeld `nl-NL` |
| `services` | Standaardkeuze van diensten, met de naam zoals de app die toont, bijvoorbeeld `["Netflix", "Disney Plus"]` |

## Als er iets misgaat

Mislukt de taak, dan stuurt GitHub een e-mail en blijft de site de vorige stand tonen. De melding in het log van de taak zegt wat er aan de hand is (watchlist niet openbaar, sleutel geweigerd, IMDb of TMDB onbereikbaar). Waarschuwingen van de laatste run staan ook in de app onder Instellingen.

IMDb heeft geen officiële API voor persoonlijke lijsten. De taak gebruikt het adres dat imdb.com zelf gebruikt; dat kan zonder aankondiging veranderen.

## Bronnen

Streamingaanbod: JustWatch, via TMDB. Dit project gebruikt de TMDB API maar is niet goedgekeurd of gecertificeerd door TMDB. Alleen voor persoonlijk, niet-commercieel gebruik.
