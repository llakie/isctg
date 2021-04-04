# Changelog

1.1.0

- Support batch size for Spam- and Ham-Box
- Add default config
- Add log output to facilitate debugging

1.0.3

- Prevent mails from being learned as ham, if the spam score calculation failed
- Fix an assignment error in the openMailbox function

1.0.2

- Fix mailcounter. Make it start from 1.. instead of 0..

1.0.1

- Fix uid range bug for inbox tracking
- Improve log output for single mail processing
- Make maximum mail size configurable

1.0.0

- Initial release