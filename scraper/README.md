### Getting started

- The project used for development
  > [remote](https://github.com/romansndlr/react-vite-realworld-example-app.git)
- Run `npm install` & `npm run dev` in project dir to run the local server.
- Get the `auth-token` after login from the [localStorage] (can possible be stored in [Cookies]
  or [sessionStorage]) in [Application] tab in google dev tools (`Ctrl + Shift + I`).
- Default token key is `jwt`, use `-k` to specify otherwise.

### Git configs

- Add configs to author commits
  > `git config --global user.name "Your Name"` > `git config --global user.email "your.email@example.com"`
- Rebase changes for clean commit history
  > Config for rebase with every pull `git config pull.rebase true` (better)
  > OR
  > Rebase explicitly `git pull --rebase`
  > Add remote `git remote add <remote eg. origin> <remote url>`
  > Stage changes `git add -A` OR use VS Code Source Control (better)
  > Commit changes `git commit` (for new local commit) & `git commit --amend` (amend unpushed commit for clean commit history)
  > Push changes `git push <remote> <branch>`

### Command

- Run the command
  > `node scraper/scraper.js -p 3000 -k "jwtToken" -t "eyJlbWFpbCI6Im..."`
- Provide `auth-token` for authentication (use quotes).
- Provide `port` if `3000` busy.

## Flags

- `-p, --port`: (Required) The application's port number, ex. `-p 3000`.

- `-o, --output`: The name for the output JSON file, ex. `-o my_data.json`.

- `-t, --auth-token`: The authentication token string (use quotes), ex. `-t "eyJhbGciOi...`.

- `-k, --token-key`: The key for the token in storage (default is "jwt"), ex. `-k "app_session"`.

- `-y, --token-type`: Where the token is stored (localStorage or cookie), ex. `-y cookie`.

### selectors.json example

- Can be optimized based on requirements.

```js
{
  "http://localhost:3000/": {
    "buttons": [
      {
        "selector": "button.show-details",
        "coordinates": "{\"x\":10,\"y\":20,...}",
        "heading": "User Details",
        "text": "Show Details",
        "isInsideForm": false,
        "revealed": [
          {
            "text_content": [
              {
                "heading": "Contact Information",
                "content": ["Email: user@example.com"]
              }
            ],
            "buttons": [
              {
                "selector": "button.close-details",
                "text": "Close",
                "...": "..."
              }
            ]
          }
        ]
      }
    ],
    "links": [
      {
        "selector": "a.nav-link",
        "coordinates": "{\"x\":10,\"y\":50,...}",
        "heading": "Main Navigation",
        "text": "Settings",
        "isInsideForm": false,
        "href": "http://localhost:3000/settings"
      }
    ],
    "inputs": [
      {
        "selector": "input[name='search']",
        "coordinates": "{\"x\":10,\"y\":80,...}",
        "heading": "Search",
        "text": "",
        "isInsideForm": true
      }
    ],
    "lists": [
      {
        "selector": "div.article-list",
        "type": "fingerprint-list",
        "items": [
          {
            "fingerprint": "div.article-preview...",
            "structure": {
              "links": [
                {
                  "selector": "a.read-more",
                  "text": "Read more...",
                  "href": "/article/how-to-scrape"
                }
              ],
              "text_content": [
                {
                  "heading": "Article Title",
                  "content": ["This is the article preview..."]
                }
              ]
            }
          }
        ]
      }
    ],
    "text_content": [
      {
        "heading": "Welcome to the Dashboard",
        "content": [
          "This is the main content area."
        ],
        "children": [
          {
            "heading": "Recent Activity",
            "content": [
              "User X completed a task.",
              "User Y posted an update."
            ]
          }
        ]
      }
    ]
  }
}
```

### List detection

- To avoid redundant scraping of list items.

* The script generates a structural "fingerprint" for each direct child element inside a potential list container.
* Nested lists within a child are replaced with a generic `_list_` placeholder, ensuring parent items have
  identical fingerprints even if their inner content varies.
* The container is identified as a list if the ratio of its children to their unique fingerprints is `3` or greater.
* Finally, it processes only the first instance of each unique fingerprint to avoid redundant scraping.

### Built-in Safety

- Ignores external links to stay within the target site.
- Avoids clicking "logout" or "sign out" buttons.
- Skips interactions with elements inside a `<form>`.
- Stops exploring an interaction path after `7` levels deep to prevent infinite loops.
