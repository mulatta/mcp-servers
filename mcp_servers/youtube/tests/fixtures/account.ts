// Minimal settings renderer shape, derived from YouTube.js CopyLink/SettingsOptions
// and the SPaccount_advanced read documented in upstream issue #783.
export function accountPage(id: string | null) {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              selected: true,
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      itemSectionRenderer: {
                        contents: [
                          {
                            settingsOptionsRenderer: {
                              title: { simpleText: "Channel ID" },
                              options: id
                                ? [
                                    {
                                      copyLinkRenderer: {
                                        shortUrl: id,
                                        style: "COPY_LINK_STYLE_DEFAULT",
                                      },
                                    },
                                  ]
                                : [],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}
