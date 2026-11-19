# D+ Routing

Application web qui génère des parcours de course à pied autour d'un point de départ en **maximisant le dénivelé positif**.

En ligne : https://roovaadii.github.io/D-Routing-/

## Fonctionnalités

- **Départ** : adresse (Nominatim), position GPS ou toucher la carte (le marqueur se déplace).
- **Distance** : curseur 2–42 km + tolérance ±5 / ±10 / ±20 % (la plage visée).
- **Modes**
  - *Boucle* : boucle qui maximise le D+ en enchaînant les vraies montées du coin, sans repasser au même endroit.
  - *Côte ×N* : trouve la côte la plus rentable à proximité et calcule le nombre de répétitions (ou utilise le nombre choisi). Trois propositions : côte courte, moyenne et longue.
- **Surface** : mixte, route ou chemin (préférence forte, pas exclusion stricte) ; option « Éviter les escaliers ».
- **Résultat** : tracé coloré selon la pente, D+ / D−, altitude min–max, D+/km, nombre de montées, profil altimétrique interactif synchronisé avec la carte, 3 variantes, export **GPX**.
- **Recherche visible** : les parcours candidats se dessinent sur la carte pendant l'optimisation, puis le gagnant se trace.

## Données (gratuites / ouvertes)

| Besoin | Source |
|---|---|
| Réseau routes et chemins | OpenStreetMap via l'API Overpass (plusieurs serveurs en secours) |
| Altitude en France | IGN RGE ALTI (modèle du **sol nu**, licence ouverte), via le WMS de la Géoplateforme |
| Altitude ailleurs / secours | Tuiles Terrarium (Mapzen / AWS Open Data : SRTM, etc.) |
| Géocodage | Nominatim (OpenStreetMap) |
| Fond de carte | Tuiles OpenStreetMap, désaturées en CSS |

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
node e2e.cjs <dossier> [repeat] # interface complète dans Chromium (Overpass simulé)
```
