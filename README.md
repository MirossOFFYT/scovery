# This world is ending — Scrzox archive

Page web statique qui lit automatiquement le dossier :

https://archive.org/download/scovery/

## Fonctionnement

- `app.js` récupère uniquement l'index racine au chargement.
- Les dossiers sont détectés automatiquement.
- Cliquer sur un dossier ouvre un panneau flottant.
- Le contenu audio de ce dossier est récupéré uniquement à ce moment-là.
- Les résultats sont mis en cache en mémoire pour éviter les requêtes répétées.
- `Scovery26` est affiché comme `This world is ending` sans renommer le dossier réel sur Archive.org.
- Aucun framework ni CSS généré : HTML/CSS/JS vanilla.

## Lancer

Tu peux simplement ouvrir `index.html`. Si le navigateur bloque les requêtes cross-origin depuis `file://`, utilise un petit serveur local :

    python -m http.server 8000

Puis ouvre :

    http://localhost:8000/
