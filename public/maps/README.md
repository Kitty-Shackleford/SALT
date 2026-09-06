# Operator-supplied map tiles

Map tile binaries are not distributed in this repository.

To enable map backgrounds, provide tiles using this layout:

```text
public/maps/<map-name>/tiles/<x>/<y>.png
```

The application requests these paths at runtime. Operators are responsible for obtaining, hosting, and attributing tiles under terms that permit their use. Never submit map tile binaries in a pull request.
