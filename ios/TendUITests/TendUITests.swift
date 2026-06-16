import XCTest

final class TendUITests: XCTestCase {
    @MainActor
    func testReviewsAFeedAndPreservesFeedBoundary() {
        let app = launchApp()
        let inbox = app.buttons["feed-inbox"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 5))
        inbox.tap()

        XCTAssertTrue(app.otherElements["review-card-inbox-agreements"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Archive"].exists)
        XCTAssertTrue(app.buttons["Talk or type"].exists)
        XCTAssertTrue(app.buttons["Review both agreements"].exists)
    }

    @MainActor
    func testSwipeArchiveOffersUndo() {
        let app = launchApp()
        app.buttons["feed-inbox"].tap()
        let card = app.otherElements["review-card-inbox-agreements"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))

        card.swipeLeft()
        let undo = app.buttons["Undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 3))
        undo.tap()

        XCTAssertTrue(card.waitForExistence(timeout: 3))
    }

    @MainActor
    func testEditableExternalActionShowsExactConfirmation() {
        let app = launchApp()
        app.buttons["feed-inbox"].tap()
        XCTAssertTrue(app.otherElements["review-card-inbox-agreements"].waitForExistence(timeout: 5))
        app.buttons["Archive"].tap()

        XCTAssertTrue(app.otherElements["review-card-inbox-cursor-reply"].waitForExistence(timeout: 5))
        app.buttons["Send reply"].tap()

        XCTAssertTrue(app.staticTexts["Confirm recipient"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts
                .containing(NSPredicate(format: "label CONTAINS %@", "dan@every.to"))
                .firstMatch
                .exists
        )
        XCTAssertTrue(app.textViews.firstMatch.exists)
    }

    @MainActor
    func testMindShowsSignalsAndExpandableFilteredSources() {
        let app = launchApp()
        app.tabBars.buttons["On Your Mind"].tap()

        XCTAssertTrue(app.staticTexts["CURRENT SYNTHESIS"].waitForExistence(timeout: 5))
        let expand = app
            .descendants(matching: .any)
            .matching(identifier: "mind-source-paywall-window-expand")
            .firstMatch
        let scrollView = app.scrollViews.firstMatch
        for _ in 0..<14 where !expand.isHittable {
            scrollView.swipeUp()
        }
        XCTAssertTrue(expand.isHittable)
        expand.tap()
        let expanded = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Hide filtered window"),
            object: expand
        )
        wait(for: [expanded], timeout: 5)
    }

    @MainActor
    func testActivityCanBeFilteredByFeed() {
        let app = launchApp()
        app.tabBars.buttons["Activity"].tap()

        XCTAssertTrue(app.staticTexts["Reply sent from dan@every.to."].waitForExistence(timeout: 5))
        app.buttons["All feeds"].tap()
        app.buttons["Company"].tap()
        XCTAssertTrue(app.staticTexts["Research three better first-screen paywall patterns."].waitForExistence(timeout: 5))
    }

    @MainActor
    func testAccessibilityAuditOnDashboardAndReview() throws {
        let app = launchApp()
        XCTAssertTrue(app.buttons["feed-inbox"].waitForExistence(timeout: 5))
        let auditTypes: XCUIAccessibilityAuditType = [
            .contrast,
            .elementDetection,
            .hitRegion,
            .sufficientElementDescription,
            .textClipped,
            .trait,
        ]
        try performAccessibilityAuditWithTimeoutRetry(in: app, for: auditTypes)

        app.buttons["feed-inbox"].tap()
        XCTAssertTrue(app.buttons["Talk or type"].waitForExistence(timeout: 5))
        try performAccessibilityAuditWithTimeoutRetry(in: app, for: auditTypes)
    }

    @MainActor
    private func performAccessibilityAuditWithTimeoutRetry(
        in app: XCUIApplication,
        for auditTypes: XCUIAccessibilityAuditType
    ) throws {
        do {
            try app.performAccessibilityAudit(for: auditTypes)
        } catch let error as NSError
            where error.domain == "com.apple.xcode.xctest.accessibilityAudit" && error.code == -56 {
            // Retry only XCTest's infrastructure timeout; audit findings still fail normally.
            app.activate()
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5))
            try app.performAccessibilityAudit(for: auditTypes)
        }
    }

    @MainActor
    private func launchApp() -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launchEnvironment["TEND_USE_FIXTURES"] = "1"
        app.launch()
        return app
    }
}
