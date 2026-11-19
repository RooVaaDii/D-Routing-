# D+ Routing

Application web qui génère des parcours de course à pied autour d'un point de départ en **maximisant le dénivelé positif**.

En ligne : https://roovaadii.github.io/D-Routing-/

## Fonctionnalités

- **Départ** : adresse (Nominatim), position GPS ou toucher la carte (le marqueur se déplace).
- **Objectif** : *distance* (curseur 2–42 km) ou *dénivelé* (curseur 50–1 500 m de D+ : le parcours le plus court qui atteint ce dénivelé). Marge ±5 / ±10 / ±20 %, avec la plage affichée (« entre 11,4 et 12,6 km »).
- **Type de sortie**
  - *Parcours varié* : une boucle qui enchaîne les vraies montées du coin.
  - *Répétitions de côte* : en « Auto », la meilleure côte du coin, montée autant de fois que la distance (ou le dénivelé visé) le demande ; avec N montées par côte, un circuit de plusieurs côtes, chacune montée N fois.
- **Options** (pondérations, pas interdictions) : remonter une même côte 1 fois / 2 / 3 / sans limite (parcours varié), ne pas repasser par le même tronçon, ne pas revenir sur une rue déjà prise (même nom OSM, même sur une autre portion), éviter les escaliers. Surface : mixte, route ou chemin.
- **Résultat** : D+ / D−, altitude min–max, D+/km, nombre de montées, profil altimétrique interactif synchronisé avec la carte, 3 variantes, export **GPX**.
- **Recherche visible** (rendu GPU) : pendant le chargement, le réseau OSM apparaît en anneaux autour du départ et le relief se dessine ; puis la carte dézoome pendant l'optimisation, les parcours candidats se dessinent progressivement, le meilleur en couleur, et le gagnant se trace en même temps que le profil.
- **Rapide** : le terrain est préchargé dès que le départ est placé ; réseau OSM et altitudes IGN gardés en cache (IndexedDB), tuiles, polices de carte et tuiles d'altitude en cache (service worker).

## Données (gratuites / ouvertes)

| Besoin | Source |
|---|---|
| Réseau routes et chemins | OpenStreetMap via l'API Overpass (plusieurs serveurs en secours) |
| Altitude en France | IGN RGE ALTI (modèle du **sol nu**, licence ouverte), via le WMS de la Géoplateforme |
| Altitude ailleurs / secours | Tuiles Terrarium (Mapzen / AWS Open Data : SRTM, etc.) |
| Géocodage | Nominatim (OpenStreetMap) |
| Fond de carte | Tuiles vectorielles OpenFreeMap (OpenMapTiles / OpenStreetMap), affichées par MapLibre GL JS (copié dans `vendor/`) avec un style maison |

## Comment le D+ est calculé (et pourquoi c'est fiable)

Les modèles d'altitude gratuits ont du « bruit » de quelques mètres. En ville, le SRTM mesure en partie le haut des bâtiments. Additionner toutes les petites variations gonfle le D+, et un optimiseur qui cherche le D+ va justement chercher ce bruit (ou une suite de petits escaliers). Pour l'éviter :

1. le modèle de terrain est lissé, et l'IGN (sol nu) est utilisé en France ;
2. le D+ affiché utilise un **seuil d'hystérésis de 5 m**, comme une montre GPS : une variation n'est comptée qu'une fois confirmée ;
3. l'optimiseur maximise une **qualité de montée** : une bosse de moins de 6 m ne rapporte rien, une montée de 25 m ou plus compte pleinement. Les parcours en « dents de scie » perdent donc face aux vraies côtes ;
4. sur les ponts et dans les tunnels, l'altitude est interpolée entre les extrémités, au lieu de suivre le fond de vallée.

## Algorithme (rapide plutôt qu'exact)

- Graphe piéton construit depuis OSM, avec l'altitude échantillonnée tous les 15 m.
- **Montées candidates** : programmation dynamique sur les arêtes montantes (coût linéaire). Pour chaque nœud et chaque tranche de longueur, elle garde la montée la plus haute qui y aboutit.
- **Boucle** : recherche heuristique en environ 3 s dans un Web Worker. Les solutions sont des suites de points de passage et de montées, reliées par un A\* attiré par les pentes et pénalisant les tronçons déjà empruntés. On combine générations aléatoires, réparation de la distance, mutations et « niches » pour garder des variantes différentes.
- **Côte ×N** : score = N × gain de la côte, avec pénalités si l'accès est trop long ou la distance hors plage.
- **Objectif dénivelé** (ajout, le mode distance est inchangé) : le score vise la valeur de D+ demandée (forte pénalité sous la marge, plus légère au-dessus), puis départage par la longueur : plus court = mieux. Les réparations de la recherche visent le D+ au lieu de la distance ; en répétitions « Auto », N est le nombre de montées juste suffisant.

## Lancer en local

Site 100 % statique :

```
python3 -m http.server 8080
```

puis ouvrir http://localhost:8080.

## Tests

```
cd tests && npm install
node synthetic.mjs              # moteur sur relief synthétique
node paris.mjs                  # moteur sur le vrai relief de Paris (réseau simulé)
node ign.mjs                    # décodage / validation de la grille IGN
node goal.mjs                   # objectif dénivelé (relief synthétique)
node goal-paris.mjs             # objectif dénivelé (relief de Paris)
node e2e.cjs <dossier>          # interface complète dans Chromium (Overpass simulé)
```
