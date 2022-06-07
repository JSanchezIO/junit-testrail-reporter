import * as TestRail from '@dlenroc/testrail';
import * as fs from 'fs';
import * as glob from 'glob';
import * as xml2js from 'xml2js';
import { logger } from './logger';
import { StatusMap } from './status-map';

export class Reporter {
  private readonly _configuration: Required<JUnitTestRailReporter.Configuration>;

  private readonly _testCaseIdRegex = /\bC(\d+)\b/g;

  private readonly _testRailMetadataRegex = /(S\d+(?:\s|_)(C\d+\s?)+)/g;

  private readonly _testSuiteIdRegex = /\bS(\d+)\b/;

  private readonly _testResults = new Map<
    number,
    {
      distinctCaseIds: Set<number>;
      testCaseResults: Array<JUnitTestRailReporter.TestCaseResult>;
    }
  >();

  constructor(configuration: Partial<JUnitTestRailReporter.Configuration>) {
    if (!configuration.host) {
      throw new Error('You must configure the `host` property');
    }

    if (!configuration.password) {
      throw new Error('You must configure the `password` property');
    }

    if (!configuration.projectId) {
      throw new Error('You must configure the `projectId` property');
    }

    if (!configuration.resultsPattern) {
      throw new Error('You must configure the `resultsPattern` property');
    }

    if (!configuration.runName) {
      throw new Error('You must configure the `runName` property');
    }

    if (!configuration.username) {
      throw new Error('You must configure the `username` property');
    }

    this._configuration = configuration as Required<JUnitTestRailReporter.Configuration>;
  }

  private _addTestCaseResult = (
    testSuiteId: number,
    testCaseId: number,
    testResult: JUnitTestRailReporter.Status,
    failureMessage?: string
  ) => {
    const testCaseResult: JUnitTestRailReporter.TestCaseResult = {
      case_id: testCaseId,
      comment: failureMessage,
      status_id: StatusMap[testResult],
    };

    const testSuiteResult = this._testResults.get(testSuiteId);

    if (testSuiteResult) {
      testSuiteResult.distinctCaseIds.add(testCaseId);
      testSuiteResult.testCaseResults.push(testCaseResult);
    } else {
      this._testResults.set(testSuiteId, {
        distinctCaseIds: new Set<number>().add(testCaseResult.case_id),
        testCaseResults: [testCaseResult],
      });
    }
  };

  private _collectFileTestResults = async (fileName: string) => {
    const report = await this._getTestFileJUnitReport(fileName);

    if (!report) {
      return;
    }

    this._parseJUnitReport(report);
  };

  private _getFileNames = (): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      glob(this._configuration.resultsPattern, (error, matches) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(matches);
      });
    });
  };

  private _getTestFileJUnitReport = (
    fileName: string
  ): Promise<JUnitTestRailReporter.JUnitReport | undefined> => {
    return new Promise<JUnitTestRailReporter.JUnitReport | undefined>((resolve, reject) => {
      fs.readFile(fileName, (error, contents) => {
        if (error) {
          reject(error);
          return;
        }

        if (!contents) {
          resolve(undefined);
          return;
        }

        const parser = new xml2js.Parser();

        parser.parseString(
          contents,
          (parseError: any, result: JUnitTestRailReporter.JUnitReport) => {
            if (parseError) {
              reject(parseError);
              return;
            }

            resolve(result);
          }
        );
      });
    });
  };

  private _isFailureArrayOfStrings = (
    failure: Required<JUnitTestRailReporter.JUnitReportTestCase>['failure']
  ): failure is Array<string> => {
    return typeof failure[0] === 'string';
  };

  private _parseJUnitReport = (report: JUnitTestRailReporter.JUnitReport) => {
    if (!report.testsuites.testsuite?.length) {
      return;
    }

    report.testsuites.testsuite.forEach((currentSuite) => {
      if (!currentSuite.testcase?.length) {
        return;
      }

      currentSuite.testcase.forEach((currentCase) => {
        const testRailMetadataMatches = [
          ...currentCase.$.name.matchAll(this._testRailMetadataRegex),
        ];

        if (!testRailMetadataMatches.length) {
          return;
        }

        testRailMetadataMatches.forEach((testRailMetadata) => {
          const testSuiteIdMatch = testRailMetadata[1].match(this._testSuiteIdRegex);

          if (!testSuiteIdMatch) {
            return;
          }

          const testSuiteId = parseInt(testSuiteIdMatch[1], 10);

          const testCaseMatches = [...testRailMetadata[1].matchAll(this._testCaseIdRegex)];

          if (!testCaseMatches.length) {
            return;
          }

          testCaseMatches.forEach((testCaseMatch) => {
            const testCaseId = parseInt(testCaseMatch[1], 10);

            if (!currentCase.failure?.length) {
              this._addTestCaseResult(
                testSuiteId,
                testCaseId,
                currentCase.skipped === undefined ? 'passed' : 'skipped'
              );
              return;
            }

            let failureMessage;

            if (this._isFailureArrayOfStrings(currentCase.failure)) {
              failureMessage = currentCase.failure.join('\n');
            } else {
              failureMessage = currentCase.failure.reduce((result, currentFailure) => {
                return `${result}${currentFailure._}\n`;
              }, '');
            }

            this._addTestCaseResult(testSuiteId, testCaseId, 'failed', failureMessage);
          });
        });
      });
    });
  };

  private _reportTestSuiteResult = async (api: TestRail, testSuiteId: number) => {
    const testSuiteResults = this._testResults.get(testSuiteId);

    if (!testSuiteResults?.distinctCaseIds.size || !testSuiteResults?.testCaseResults.length) {
      logger.warning(`We were unable to find any test cases for ${testSuiteId}`);
      return;
    }

    try {
      const testRailRun = await api.addRun(this._configuration.projectId, {
        case_ids: [...testSuiteResults.distinctCaseIds],
        include_all: false,
        name: this._configuration.runName,
        suite_id: testSuiteId,
      });
  
      await api.addResultsForCases(testRailRun.id, {
        results: testSuiteResults.testCaseResults,
      });
  
      await api.closeRun(testRailRun.id);
      
      logger.info(
        `Successfully created and closed TestRail run R${testRailRun.id} for S${testSuiteId}!`
      );
    } catch (error) {
      logger.error(error);
      return;      
    }
  };

  public reportResults = async () => {
    const fileNames = await this._getFileNames();

    if (!fileNames.length) {
      logger.warning('No test result files were found.');
      return;
    }

    await Promise.allSettled(fileNames.map(this._collectFileTestResults));

    if (this._testResults.size === 0) {
      logger.warning('No test case results were found to report.');
      return;
    }

    const api = new TestRail({
      host: this._configuration.host,
      password: this._configuration.password,
      username: this._configuration.username,
    });

    const testSuiteIds = [...this._testResults.keys()];

    await Promise.allSettled(
      testSuiteIds.map((testSuiteId) => this._reportTestSuiteResult(api, testSuiteId))
    );

    logger.success('Finished!');
  };
}
