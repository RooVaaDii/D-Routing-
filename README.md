# Parcours D+

Prototype d'application web qui génère des parcours de course à pied autour d'un point de départ en maximisant le dénivelé positif.

- **Boucle max D+** : recherche heuristique (quelques secondes) de boucles qui passent par les meilleures montées du coin.
- **Répétitions de côte** : trouve la côte la plus rentable à proximité et calcule le nombre de répétitions (ou utilise celui choisi).
- Surface : mixte, route ou chemin. Profil altimétrique, export GPX.

Données et services gratuits uniquement : OpenStreetMap (Overpass, Nominatim, tuiles), altitudes Terrarium (Mapzen / AWS Open Data), Leaflet.

## Lancer

Site 100 % statique :

```
python3 -m http.server 8080
```

puis ouvrir http://localhost:8080.

## Tests

```
cd tests && npm install && node synthetic.mjs
```
