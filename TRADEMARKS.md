# Trademark policy

The code of Notepadly is free: under the [Apache License 2.0](LICENSE) you may use, copy, change, share and sell it, for any purpose, at no cost.

The **brand** is not part of that license. Section 6 of the Apache License states that it "does not grant permission to use the trade names, trademarks, service marks, or product names of the Licensor". This page explains what that means for Notepadly.

## What the brand includes

- The name **Notepadly**, and names that could be confused with it (for example "Notepadly Pro", "NotepadlyX", "Notepad-ly").
- The **Notepadly icon and logo**: the notepad with the lightning bolt, in every size and colour, including the files in `src-tauri/icons` and `src/assets/app-icon-*.png`.
- The app identifier `com.hamza.notepadly`.

All of these belong to Hamza Javed.

## You may

- Use, change, share and sell the code, as the Apache License allows.
- Share **unmodified** official builds under the name Notepadly, with the official icon.
- Say truthfully that your project is "based on Notepadly", "a fork of Notepadly" or "compatible with Notepadly".
- Use the name Notepadly to refer to this project, for example in articles, reviews, comparisons and tutorials.

## You may not

- Publish, sell or distribute a **modified** version under the name Notepadly, or under a name that could be confused with it.
- Use the Notepadly icon or logo for your own build, product, website or service.
- Suggest that your project is the official Notepadly, or that it is made, endorsed or supported by the Notepadly author, when it is not.
- Register the name Notepadly, or a confusingly similar name, as a trademark, domain name, app store listing or social media account.

## If you make your own version

Before you release it:

1. Choose a new name, and replace "Notepadly" in `package.json`, `src-tauri/tauri.conf.json` (`productName`, window `title`), `src-tauri/Cargo.toml` and the user interface.
2. Change the app identifier `com.hamza.notepadly` in `src-tauri/tauri.conf.json`.
3. Replace the icon: edit `src-tauri/icons/source/notepadly-icon.svg` into your own design and run `npm run icons`.
4. Keep the `LICENSE` and `NOTICE` files, as the Apache License requires, and state that you changed the files.

## Other trademarks

Microsoft, Windows and Notepad are trademarks of Microsoft Corporation. Notepadly is an independent project and is not affiliated with, endorsed by or sponsored by Microsoft. Windows Notepad appears in this project's screenshots only for comparison.

## Questions

To ask for permission beyond this policy, open an issue on the [GitHub repository](https://github.com/Mr-Hamza-Javed/Notepadly/issues).
