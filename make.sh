#!/bin/bash
set -euo pipefail

escape_html() {
    sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

CSS=$(echo "<style type='text/css'>$(cat src/seaoflogs.css)</style>" | escape_html)
JS=$(echo "<script>$(cat src/seaoflogs.js)</script>" | escape_html)
INDEX=$(cat src/host.html | sed "s!&lt;link rel=&quot;stylesheet&quot; href=&quot;seaoflogs.css&quot; /&gt;!@@@CSS@@@!g" | sed "s!&lt;script src=&quot;seaoflogs.js&quot;&gt;&lt;/script&gt;!@@@JS@@@!g")
INDEX=${INDEX//@@@CSS@@@/$CSS}
INDEX=${INDEX//@@@JS@@/$JS}
echo "$INDEX" > index.html
cp index.html demo.html
( cd demo_src && tail -n +1 * ) >> demo.html

