# Apply Connected UI wiring

New files are already on this branch. Wire them with:

```bash
git checkout ui/connected-review-list
git apply patches/connected-ui.diff
git add src/index.js src/db.js
git commit -m "Wire review list into /connected and hello@replyr.pro contact"
git push
```

Then merge the PR. Railway will deploy replyr.pro.
