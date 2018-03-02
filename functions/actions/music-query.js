const debug = require('debug')('ia:actions:music-query:debug');
const warning = require('debug')('ia:actions:music-query:warning');
const _ = require('lodash');
const math = require('mathjs');
const mustache = require('mustache');

const dialog = require('../dialog');
const feeders = require('../extensions/feeders');
const {getSuggestionProviderForSlots} = require('../extensions/suggestions');
const humanize = require('../humanize');
const {
  extractRequrements,
  getMatchedTemplates,
  getMatchedTemplatesExactly,
  getPromptsForSlots,
  getRequiredExtensionHandlers,
} = require('../slots/slots-of-template');
const playlist = require('../state/playlist');
const querySlots = require('../state/query');
const availableSchemes = require('../strings').intents.musicQuery;

/**
 * Handle music query action
 * - fill slots of music query
 * - call fulfilment feeder
 *
 * TODO:
 * 1) it seems we could use express.js/koa middleware architecture here
 * 2) all that could should be builder for any slot-based actions
 * and should be placed to ./helpers.
 *
 * @param app
 * @returns {Promise}
 */
function handler (app) {
  debug('Start music query handler');

  const answer = [];

  let slotScheme = getActualSlotScheme(availableSchemes, querySlots.getSlots(app));
  checkSlotScheme(slotScheme);
  let newValues = fillSlots(app, slotScheme);
  applyDefaultSlots(app, slotScheme);

  // new values could change actual slot scheme
  const newScheme = getActualSlotScheme(availableSchemes, querySlots.getSlots(app));
  if (slotScheme !== newScheme) {
    slotScheme = newScheme;
    // update slots for new scheme
    checkSlotScheme(slotScheme);
    newValues = Object.assign({}, newValues, fillSlots(app, slotScheme));
    applyDefaultSlots(app, slotScheme);
  }

  const complete = querySlots.hasSlots(app, slotScheme.slots);
  if (complete) {
    debug('we got all needed slots');
    const feeder = feeders.getByName(slotScheme.fulfillment);
    if (!feeder) {
      // TODO: we should softly fallback here
      warning(`we need feeder "${slotScheme.fulfillment}" for fulfillment slot dialog`);
      return Promise.resolve();
    } else {
      return feeder
        .build(app, querySlots, playlist)
        .then(() => {
          if (feeder.isEmpty(app, querySlots, playlist)) {
            // TODO: feeder can't find anything by music query
            // isn't covered case should be implemented
            dialog.ask(
              `We haven't find anything by your request would you like something else?`
            );
          } else {
            dialog.playSong(app, feeder.getCurrentItem(app, querySlots, playlist));
          }
        });
    }
  }

  return generateAcknowledge(app, slotScheme, newValues)
    .then(res => {
      answer.push(res);
      return generatePrompt(app, slotScheme);
    })
    .then(res => {
      answer.push(res);

      const groupedAnswers = groupAnswers(answer);
      if (groupedAnswers.speech && groupedAnswers.speech.length > 0) {
        dialog.ask(app, {
          speech: groupedAnswers.speech.join(' '),
          suggestions: groupedAnswers.suggestions,
        });
      } else {
        // TODO: we don't have anything to say should warn about it
      }
    });
}

/**
 *
 * @param slotScheme
 */
function checkSlotScheme (slotScheme) {
  if (!slotScheme) {
    throw new Error('There are no valid slot scheme. Need at least default');
  }

  if (slotScheme && slotScheme.name) {
    debug(`we are going with "${slotScheme.name}" slot scheme`);
  }
}

/**
 * Apply default slots from slotsScheme
 *
 * @param app
 * @param slotsScheme
 */
function applyDefaultSlots (app, slotsScheme) {
  if (!slotsScheme.defaults) {
    return;
  }

  const appliedDefaults = Object.keys(slotsScheme.defaults)
    .filter(defaultSlotName => !querySlots.hasSlot(app, defaultSlotName))
    .map(defaultSlotName => {
      querySlots.setSlot(
        app,
        defaultSlotName,
        slotsScheme.defaults[defaultSlotName]
      );

      return defaultSlotName;
    });

  debug('We have used defaults:', appliedDefaults);
}

/**
 * Get valid slot scheme by to meet conditions
 *
 * @param availableSchemes
 * @param slotsState
 * @returns {*}
 */
function getActualSlotScheme (availableSchemes, slotsState) {
  if (!Array.isArray(availableSchemes)) {
    return availableSchemes;
  }

  return availableSchemes.find((scheme, idx) => {
    if (!scheme.conditions) {
      // DEFAULT
      debug('we get default slot scheme');

      // if scheme doesn't have conditions it is default scheme
      // usually it is at the end of list

      if (idx < availableSchemes.length - 1) {
        // if we have schemes after the default one
        // we should warn about it
        // because we won't never reach schemes after default one
        warning('we have schemes after the default one', scheme.name || '');
      }
      return true;
    }

    // all conditionals should be valid
    try {
      return scheme.conditions
        .every(condition => math.eval(condition, slotsState));
    } catch (error) {
      debug(`Get error from Math.js:`, error && error.message);
      return false;
    }
  });
}

/**
 * Squeeze array of answer in the single object of arrays
 *
 * @param {Array} answer
 * @returns {Object}
 */
function groupAnswers (answer) {
  return answer
  // skip empty responses
    .filter(a => a)
    // squeeze fields of answers in the single object
    .reduce(
      (acc, value) =>
        // get each new value ...
        Object.keys(value)
          .reduce(
            (acc, newKey) =>
              // and patch initial object with it
              Object.assign(acc, {
                [newKey]: (acc[newKey] || []).concat(value[newKey]),
              }),
            acc),
      {}
    );
}

/**
 * Put all received values to slots
 * and return list of new values
 *
 * @param app
 * @returns {{}}
 */
function fillSlots (app, slotScheme) {
  return slotScheme.slots
    .reduce((newValues, slotName) => {
      const value = app.getArgument(slotName);
      if (value) {
        querySlots.setSlot(app, slotName, value);
        newValues[slotName] = value;
      }
      return newValues;
    }, {});
}

/**
 * Generate acknowledge message for received values
 *
 * @param app
 * @param newValues
 * @returns {*}
 */
function generateAcknowledge (app, slotScheme, newValues) {
  debug('we had slots:', Object.keys(querySlots.getSlots(app)));

  const newNames = Object.keys(newValues);
  // we get new values
  if (newNames.length === 0) {
    debug(`we don't get any new values`);
    return Promise.resolve(null);
  }

  debug('and get new slots:', newValues);

  const acknowledgeRequirements = extractRequrements(slotScheme.acknowledges);

  // find the list of acknowledges which match recieved slots
  let validAcknowledges = getMatchedTemplatesExactly(
    acknowledgeRequirements,
    newNames
  );

  if (validAcknowledges && validAcknowledges.length === 0) {
    validAcknowledges = getMatchedTemplates(
      acknowledgeRequirements,
      newNames
    );
  }

  if (!validAcknowledges || validAcknowledges.length === 0) {
    warning(`there is no valid acknowledges for ${newNames}. Maybe we should write few?`);
    return Promise.resolve(null);
  }

  debug('we have few valid acknowledges', validAcknowledges);

  const template = _.sample(validAcknowledges);
  const context = querySlots.getSlots(app);

  // mustachejs doesn't support promises on-fly
  // so we should solve all them before and fetch needed data
  return resolveSlots(context, template)
    .then(resolvedSlots => ({
      speech: mustache.render(
        template,
        Object.assign({}, newValues, resolvedSlots)
      )
    }));
}

/**
 * Resolve all template slots which refers to extensions
 *
 * some slots could be resolved in more friendly look
 * for example we could convert creatorId to {title: <band-name>}
 *
 * @param context
 * @param template
 * @returns {Promise.<TResult>}
 */
function resolveSlots (context, template) {
  debug(`resolve slots for "${template}"`);
  const extensions = getRequiredExtensionHandlers(template);
  debug('we get extensions:', extensions);
  return Promise
    .all(
      extensions
        .map(({handler}) => handler(context))
    )
    .then(solutions => {
      debug('solutions:', solutions);
      return solutions
      // zip/merge to collections
        .map((res, index) => {
          const extension = extensions[index];
          return Object.assign({}, extension, {result: res});
        })
        // pack result in the way:
        // [__<extension_type>].[<extension_name>] = result
        .reduce((acc, extension) => {
          debug(`we get result extension.result: ${extension.result} to bake for ${extension.name}`);
          return Object.assign({}, acc, {
            ['__' + extension.extType]: {
              [extension.name]: extension.result,
            },
          });
        }, {});
    });
}

/**
 * Fetch suggestions for slots
 *
 * @param app
 * @param promptScheme
 * @returns {Promise}
 */
function fetchSuggestions (app, promptScheme) {
  let suggestions = promptScheme.suggestions;

  if (suggestions) {
    debug('have static suggestions', suggestions);
    return Promise.resolve(suggestions);
  }

  const provider = getSuggestionProviderForSlots(promptScheme.requirements);
  if (!provider) {
    warning(`don't have any suggestions for: ${promptScheme.requirements}. Maybe we should add them.`);
    return Promise.resolve(null);
  }

  return provider(querySlots.getSlots(app))
    .then(res => {
      const suggestions = res.items.slice(0, 3);
      if (promptScheme.suggestionTemplate) {
        return suggestions.map(
          item => mustache.render(promptScheme.suggestionTemplate, item)
        );
      } else {
        return suggestions.map(
          item => _.values(item).join(' ')
        );
      }
    });
}

/**
 * Generate prompt for missed slots
 *
 * @param app
 * @returns {*}
 */
function generatePrompt (app, slotScheme) {
  const missedSlots =
    slotScheme.slots
      .filter(slotName => !querySlots.hasSlot(app, slotName));

  if (missedSlots.length === 0) {
    debug(`we don't have any missed slots`);
    return Promise.resolve(null);
  }

  debug('we missed slots:', missedSlots);
  const promptScheme = getPromptsForSlots(
    slotScheme.prompts,
    missedSlots
  );

  if (!promptScheme) {
    warning(`we don't have any matched prompts`);
    return Promise.resolve(null);
  }

  const prompt = _.sample(promptScheme.prompts);

  debug('we randombly choice prompt:', prompt);
  return fetchSuggestions(app, promptScheme)
    .then((suggestions) => {
      const speech = mustache.render(prompt, {
        // TODO: pass all slots and suggestions as context
        suggestions: {
          humanized: humanize.list.toFriendlyString(suggestions, {ends: ' or '}),
          values: suggestions,
        },
      });

      return {speech, suggestions};
    });
}

module.exports = {
  handler,
};