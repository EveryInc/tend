import Foundation

enum FixtureData {
    static let snapshot = MobileSnapshot(
        feeds: feeds,
        cards: cards,
        mind: mind,
        activities: activities,
        sync: MobileSync(
            workerId: "tend-fixture",
            schemaVersion: 1,
            snapshotGeneration: "fixture-generation",
            lastHeartbeatAt: timestamp(minutesAgo: 1),
            lastError: nil,
            updatedAt: timestamp(minutesAgo: 1)
        )
    )

    static let feeds: [MobileFeed] = [
        feed("inbox", "Inbox", "Email decisions and replies", 0, 3, "Rachel and Adam's agreements are ready"),
        feed("company-attention", "Company", "Signals, people, and operating decisions", 1, 1, "The paywall work now has a sharper question"),
        feed("every", "Every", "Editorial, product, and audience opportunities", 2, 1, "A new distribution experiment is worth testing"),
        feed("proof-pulse", "Proof", "Product quality and retention evidence", 3, 1, "Repeat-work improved after the latest release"),
    ]

    static let cards: [MobileCard] = [
        agreementCard,
        replyCard,
        paywallCard,
        researchCard,
        chartCard,
        routineCard,
    ]

    static let mind = MobileMind(
        health: "fresh",
        current: MobileMindUpdate(
            id: "mind-fixture",
            state: "fresh",
            publishedAt: timestamp(minutesAgo: 8),
            observedFrom: timestamp(minutesAgo: 24),
            observedTo: timestamp(minutesAgo: 10),
            summary: "You are deciding how to improve the mobile paywall, while tightening the hiring bar and making Tend easier to use from your phone.",
            signals: [
                MobileMindSignal(
                    id: "paywall",
                    kind: "changed_now",
                    title: "Paywall diagnosis",
                    summary: "The question shifted from whether to stop the test to how the mobile page should earn the paid choice.",
                    observationIds: ["paywall-window", "pricing-note"]
                ),
                MobileMindSignal(
                    id: "hiring",
                    kind: "ongoing",
                    title: "Distinctive hiring judgment",
                    summary: "You keep returning to maker-first depth, non-generic craft, and explicit tradeoffs.",
                    observationIds: ["hiring-window"]
                ),
                MobileMindSignal(
                    id: "mobile-tend",
                    kind: "unresolved",
                    title: "Tend should travel",
                    summary: "The remaining question is whether reviewing cards on iPhone can feel faster than supervising the desktop app.",
                    observationIds: ["tend-window"]
                ),
            ],
            observations: [
                MobileMindObservation(
                    id: "paywall-window",
                    kind: "chronicle_ocr",
                    title: "Mobile pricing review",
                    app: "Codex",
                    artifact: "Every Performance",
                    observedFrom: timestamp(minutesAgo: 24),
                    observedTo: timestamp(minutesAgo: 18),
                    excerpt: "The annual paid CTA begins below the fold while free choices dominate the first screen.",
                    fullText: "Reviewed the mobile page at multiple viewport sizes. The hero explains the product, but the strongest paid choice arrives after several competing free paths. The next useful test should change the first-screen hierarchy rather than only the checkout redirect.",
                    href: "https://every.to",
                    redactionCount: 2
                ),
                MobileMindObservation(
                    id: "pricing-note",
                    kind: "source_receipt",
                    title: "Every Pulse analysis",
                    app: "Tend",
                    artifact: "Every Performance",
                    observedFrom: timestamp(minutesAgo: 17),
                    observedTo: timestamp(minutesAgo: 15),
                    excerpt: "Behavioral evidence supports a page diagnosis; billing truth still needs ChartMogul.",
                    fullText: nil,
                    href: nil,
                    redactionCount: 0
                ),
                MobileMindObservation(
                    id: "hiring-window",
                    kind: "chronicle_ocr",
                    title: "Hiring calibration",
                    app: "Codex",
                    artifact: "Hiring",
                    observedFrom: timestamp(minutesAgo: 15),
                    observedTo: timestamp(minutesAgo: 12),
                    excerpt: "The recurring standard is distinctive judgment over generic competence.",
                    fullText: "Compared candidate materials and preserved the strongest maker-first criteria as reviewable policy rather than automatically applying them.",
                    href: nil,
                    redactionCount: 1
                ),
                MobileMindObservation(
                    id: "tend-window",
                    kind: "chronicle_ocr",
                    title: "Native Tend planning",
                    app: "Codex",
                    artifact: "Improve Tend workflow",
                    observedFrom: timestamp(minutesAgo: 12),
                    observedTo: timestamp(minutesAgo: 10),
                    excerpt: "A native review deck should make each feed easy to clear without moving execution onto the phone.",
                    fullText: "The phone remains an approval and response surface. Local Tend owns workflow state and Codex owns execution.",
                    href: nil,
                    redactionCount: 0
                ),
            ],
            contentDigest: "fixture-mind-digest",
            freshUntil: timestamp(minutesAgo: -160)
        ),
        lastFresh: nil,
        history: []
    )

    static let activities: [MobileActivity] = [
        MobileActivity(
            id: UUID(uuidString: "10000000-0000-0000-0000-000000000001")!,
            feedId: "inbox",
            cardId: "cursor-logistics",
            kind: "approve_action",
            payload: MobileActivityPayload(actionId: "send", instruction: "Send reply", riskConfirmation: nil),
            state: "applied",
            availableAt: timestamp(minutesAgo: 42),
            resultWorkId: "work-1",
            workStatus: "completed",
            response: "Reply sent from dan@every.to.",
            error: nil,
            createdAt: timestamp(minutesAgo: 42),
            updatedAt: timestamp(minutesAgo: 38)
        ),
        MobileActivity(
            id: UUID(uuidString: "10000000-0000-0000-0000-000000000002")!,
            feedId: "company-attention",
            cardId: "paywall-ideas",
            kind: "instruction",
            payload: MobileActivityPayload(actionId: nil, instruction: "Research three better first-screen paywall patterns.", riskConfirmation: nil),
            state: "applied",
            availableAt: timestamp(minutesAgo: 5),
            resultWorkId: "work-2",
            workStatus: "working",
            response: nil,
            error: nil,
            createdAt: timestamp(minutesAgo: 5),
            updatedAt: timestamp(minutesAgo: 2)
        ),
        MobileActivity(
            id: UUID(uuidString: "10000000-0000-0000-0000-000000000003")!,
            feedId: "inbox",
            cardId: "agreements",
            kind: "dismiss",
            payload: MobileActivityPayload(actionId: "dismiss-card", instruction: nil, riskConfirmation: nil),
            state: "applied",
            availableAt: timestamp(minutesAgo: 30),
            resultWorkId: nil,
            workStatus: nil,
            response: "Removed from Tend. The email was left untouched.",
            error: nil,
            createdAt: timestamp(minutesAgo: 30),
            updatedAt: timestamp(minutesAgo: 29)
        ),
    ]

    private static let agreementCard = card(
        key: "inbox:agreements",
        feed: "inbox",
        id: "agreements",
        position: 0,
        eyebrow: "Cora · Signing",
        title: "Rachel and Adam's option agreements are ready for your countersignature",
        why: "Matthew resent both DocuSigns. Rachel's payment coordination begins after her agreement is executed.",
        blocks: [
            MobileBlock(id: "attention", type: "memo", label: "What needs attention", title: nil, text: "Review and countersign both option exercise agreements. The signing links are evidence, not authorization to sign.", value: nil, items: nil, before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: nil),
            MobileBlock(id: "sources", type: "evidence", label: "Cora items", title: nil, text: nil, value: nil, items: [
                .detail(.init(label: "Rachel Jepsen agreement", detail: "DocuSign", checked: nil, href: "https://example.com/rachel", linkAvailability: "external")),
                .detail(.init(label: "Adam Keesling agreement", detail: "DocuSign", checked: nil, href: "https://example.com/adam", linkAvailability: "external")),
                .detail(.init(label: "Matthew's coordination note", detail: "Gmail", checked: nil, href: "https://mail.google.com", linkAvailability: "external")),
            ], before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: nil),
        ],
        actions: [
            action("default-cleanup", "Archive", "default_cleanup", "cleanup-agreements", variant: "secondary"),
            action("dismiss-card", "Dismiss card", "dismiss_card", "dismiss-agreements", variant: "secondary"),
            action("review", "Review both agreements", "queue_instruction", "review-agreements", variant: "primary"),
        ]
    )

    private static let replyCard = card(
        key: "inbox:cursor-reply",
        feed: "inbox",
        id: "cursor-reply",
        position: 1,
        eyebrow: "Inbox · Reply",
        title: "Cursor needs the final event logistics",
        why: "The thread is waiting on one concise confirmation from you.",
        sourceMailbox: "dan@every.to",
        blocks: [
            MobileBlock(id: "thread", type: "email_thread", label: "Latest email", title: nil, text: "From: Events <events@example.com>\nTo: Dan <dan@every.to>\nSubject: Cursor event logistics\n\nCan you confirm arrival time and whether you need a hotel room?", value: nil, items: nil, before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: nil),
            MobileBlock(id: "draft", type: "editable_text", label: "Draft reply", title: nil, text: nil, value: "I can arrive by 4:30 PM and don't need a hotel room. Looking forward to it!\n\nDan", items: nil, before: nil, after: nil, editable: true, profile: nil, video: nil, chart: nil),
        ],
        actions: [
            action("default-cleanup", "Archive", "default_cleanup", "cleanup-reply", variant: "secondary"),
            action("send", "Send reply", "approve_action", "send-reply", artifact: "draft", external: true, variant: "primary"),
        ]
    )

    private static let paywallCard = card(
        key: "company-attention:paywall",
        feed: "company-attention",
        id: "paywall",
        position: 0,
        eyebrow: "Company · Growth",
        title: "The mobile paywall problem is now specific enough to test",
        why: "The first screen sells the product but delays the paid choice. A reversible hierarchy test can answer the next question.",
        context: MobileContextInfluence(
            updateId: "mind-fixture",
            signalIds: ["paywall"],
            mode: "research",
            effect: "selected",
            summary: "You are actively deciding how to improve the mobile paywall.",
            researchQuestion: "Which first-screen hierarchy would make the paid choice legible without hiding free access?",
            sourceCount: 2
        ),
        blocks: [
            MobileBlock(id: "decision", type: "memo", label: "Why now", title: nil, text: "The annual CTA starts below the fold, while free-choice links dominate the visible decision area.", value: nil, items: nil, before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: nil),
            MobileBlock(id: "options", type: "options", label: "Test candidates", title: nil, text: nil, value: nil, items: [
                .detail(.init(label: "Paid-first hierarchy", detail: "Move the annual choice into the first viewport.", checked: nil, href: nil, linkAvailability: nil)),
                .detail(.init(label: "Context-first hierarchy", detail: "Keep the story, but collapse competing free paths.", checked: nil, href: nil, linkAvailability: nil)),
            ], before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: nil),
        ],
        actions: [
            action("default-cleanup", "Archive", "default_cleanup", "cleanup-paywall", variant: "secondary"),
            action("research", "Develop the test", "queue_instruction", "research-paywall", variant: "primary"),
        ]
    )

    private static let researchCard = card(
        key: "every:distribution",
        feed: "every",
        id: "distribution",
        position: 0,
        eyebrow: "Every · Opportunity",
        title: "A weekly field note could turn internal product work into audience growth",
        why: "The recent paywall, Proof, and AI-news work all contain useful public lessons without requiring a large editorial package.",
        blocks: [
            MobileBlock(id: "idea", type: "rich_text", label: nil, title: nil, text: "**Format:** one sharp observation, one screenshot or chart, and one decision Every is making next.", value: nil, items: nil, before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: nil),
            MobileBlock(id: "checklist", type: "checklist", label: "First three", title: nil, text: nil, value: nil, items: [
                .detail(.init(label: "What our paywall taught us", detail: nil, checked: false, href: nil, linkAvailability: nil)),
                .detail(.init(label: "Why repeat work is a better AI metric", detail: nil, checked: false, href: nil, linkAvailability: nil)),
                .detail(.init(label: "How we react to breaking AI news", detail: nil, checked: false, href: nil, linkAvailability: nil)),
            ], before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: nil),
        ],
        actions: [
            action("default-cleanup", "Archive", "default_cleanup", "cleanup-distribution", variant: "secondary"),
            action("outline", "Draft the first outline", "queue_instruction", "outline-field-note", variant: "primary"),
        ]
    )

    private static let chartCard = card(
        key: "proof-pulse:retention",
        feed: "proof-pulse",
        id: "retention",
        position: 0,
        eyebrow: "Proof · Retention",
        title: "Worked again is becoming the more useful repeat-value signal",
        why: "D1 came-back remains flat, but D1 worked-again improved after the collaboration fixes.",
        blocks: [
            MobileBlock(id: "chart", type: "chart", label: "D1 cohorts", title: nil, text: nil, value: nil, items: nil, before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: MobileChart(
                unit: "%",
                max: 40,
                series: [.init(label: "Came back"), .init(label: "Worked again")],
                rows: [
                    .init(label: "Before", values: [27, 12], detail: "May cohorts"),
                    .init(label: "After", values: [28, 24], detail: "June cohorts"),
                ],
                note: "Illustrative fixture data"
            )),
        ],
        actions: [
            action("default-cleanup", "Archive", "default_cleanup", "cleanup-retention", variant: "secondary"),
            action("instrument", "Instrument repeat work", "queue_instruction", "instrument-repeat", variant: "primary"),
        ]
    )

    private static let routineCard = card(
        key: "inbox:routine:cleanup",
        feed: "inbox",
        id: "routine:cleanup",
        itemKind: "routine_action_group",
        position: 2,
        eyebrow: "Routine review",
        title: "Likely archive",
        why: "Three notices have no reply, decision, or downstream dependency.",
        blocks: [
            MobileBlock(id: "items", type: "checklist", label: "3 items", title: nil, text: nil, value: nil, items: [
                .detail(.init(label: "Weekly billing receipt", detail: "No action required", checked: false, href: nil, linkAvailability: nil)),
                .detail(.init(label: "Calendar update", detail: "Already reflected on calendar", checked: false, href: nil, linkAvailability: nil)),
                .detail(.init(label: "Product newsletter", detail: "No current relevance", checked: false, href: nil, linkAvailability: nil)),
            ], before: nil, after: nil, editable: nil, profile: nil, video: nil, chart: nil),
        ],
        actions: [
            action("approve-routine-action", "Archive all three", "approve_action", "routine-cleanup", external: true, variant: "primary"),
        ],
        routine: "cleanup"
    )

    private static func feed(
        _ id: String,
        _ name: String,
        _ purpose: String,
        _ position: Int,
        _ review: Int,
        _ latest: String
    ) -> MobileFeed {
        MobileFeed(
            id: id,
            name: name,
            purpose: purpose,
            position: position,
            currentPass: 15,
            generation: "pass:15",
            reviewCount: review,
            queuedCount: id == "company-attention" ? 1 : 0,
            workingCount: id == "company-attention" ? 1 : 0,
            doneCount: 18 + position * 11,
            latestCardTitle: latest,
            latestCardUpdatedAt: timestamp(minutesAgo: position * 9 + 2),
            updatedAt: timestamp(minutesAgo: position * 3 + 1)
        )
    }

    private static func card(
        key: String,
        feed: String,
        id: String,
        itemKind: String = "attention",
        position: Int,
        eyebrow: String,
        title: String,
        why: String,
        sourceMailbox: String? = nil,
        context: MobileContextInfluence? = nil,
        blocks: [MobileBlock],
        actions: [MobileAction],
        routine: String? = nil
    ) -> MobileCard {
        MobileCard(
            key: key,
            itemKind: itemKind,
            feedId: feed,
            cardId: id,
            routineActionGroupId: routine,
            feedGeneration: "pass:15",
            cardDigest: "digest-\(key)",
            status: "to_review_new",
            reviewPosition: position,
            reviewable: true,
            title: title,
            eyebrow: eyebrow,
            why: why,
            sourceMailbox: sourceMailbox,
            contextInfluence: context,
            blocks: blocks,
            actions: actions,
            activeWork: nil,
            createdAt: timestamp(minutesAgo: 90 - position),
            updatedAt: timestamp(minutesAgo: 5 + position),
            completedAt: nil
        )
    }

    private static func action(
        _ id: String,
        _ label: String,
        _ behavior: String,
        _ digest: String,
        artifact: String? = nil,
        external: Bool? = nil,
        variant: String
    ) -> MobileAction {
        MobileAction(
            id: id,
            label: label,
            behavior: behavior,
            digest: digest,
            artifactBlockId: artifact,
            externalMutation: external,
            variant: variant,
            confirmation: label == "Send reply"
                ? MobileActionConfirmation(
                    kind: "external_recipient",
                    title: "Confirm recipient",
                    message: "This authorizes one exact reply from dan@every.to to events@example.com. No second chat confirmation will be requested.",
                    recipients: ["events@example.com"]
                )
                : nil
        )
    }

    private static func timestamp(minutesAgo: Int) -> String {
        Date(timeIntervalSinceNow: TimeInterval(-minutesAgo * 60)).tendTimestamp
    }
}
