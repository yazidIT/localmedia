var util = require('util');
var hark = require('hark');
var WildEmitter = require('wildemitter');
var mockconsole = require('mockconsole');

function isAllTracksEnded(stream) {
    var isAllTracksEnded = true;
    stream.getTracks().forEach(function (t) {
        isAllTracksEnded = t.readyState === 'ended' && isAllTracksEnded;
    });
    return isAllTracksEnded;
}

function isScreenShareSourceAvailable() {
    // currently we only support chrome v70+ (w/ experimental features enabled, if necessary)
    // and firefox
    return (navigator.getDisplayMedia ||
            !!navigator.mediaDevices.getSupportedConstraints().mediaSource);
}

function shouldWorkAroundFirefoxStopStream() {
  if (typeof window === 'undefined') {
    return false;
  }
  if (!window.navigator.mozGetUserMedia) {
    return false;
  }
  var match = window.navigator.userAgent.match(/Firefox\/(\d+)\./);
  var version = match && match.length >= 1 && parseInt(match[1], 10);
  return version < 50;
}

function LocalMedia(opts) {
    WildEmitter.call(this);

    var config = this.config = {
        detectSpeakingEvents: false,
        audioFallback: false,
        media: {
            audio: true,
            video: true
        },
        harkOptions: null,
        logger: mockconsole
    };

    var item;
    for (item in opts) {
        if (opts.hasOwnProperty(item)) {
            this.config[item] = opts[item];
        }
    }

    this.logger = config.logger;
    this._log = this.logger.log.bind(this.logger, 'LocalMedia:');
    this._logerror = this.logger.error.bind(this.logger, 'LocalMedia:');

    this.localStreams = [];
    this.localScreens = [];

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this._logerror('Your browser does not support local media capture.');
    }

    this._audioMonitors = [];
    this.on('localStreamStopped', this._stopAudioMonitor.bind(this));
    this.on('localScreenStopped', this._stopAudioMonitor.bind(this));
}

util.inherits(LocalMedia, WildEmitter);


LocalMedia.prototype.start = function (mediaConstraints, cb) {
    var self = this;
    var constraints = mediaConstraints || this.config.media;

    this.emit('localStreamRequested', constraints);

    navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
        if (constraints.audio && self.config.detectSpeakingEvents) {
            self._setupAudioMonitor(stream, self.config.harkOptions);
        }
        self.localStreams.push(stream);

        stream.getTracks().forEach(function (track) {
            track.addEventListener('ended', function () {
                if (isAllTracksEnded(stream)) {
                    self._removeStream(stream);
                }
            });
        });

        self.emit('localStream', stream);

        if (cb) {
            return cb(null, stream);
        }
    }).catch(function (err) {
            // Fallback for users without a camera
            if (self.config.audioFallback && err.name === 'NotFoundError' && constraints.video !== false) {
                constraints.video = false;
                self.start(constraints, cb);
                return;
            }

        self.emit('localStreamRequestFailed', constraints);

        if (cb) {
            return cb(err, null);
        }
    });
};

LocalMedia.prototype.stop = function (stream) {
    this.stopStream(stream);
    this.stopScreenShare(stream);
};

LocalMedia.prototype.stopStream = function (stream) {
    var self = this;

    if (stream) {
        var idx = this.localStreams.indexOf(stream);
        if (idx > -1) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            //Half-working fix for Firefox, see: https://bugzilla.mozilla.org/show_bug.cgi?id=1208373
            if (shouldWorkAroundFirefoxStopStream()) {
                this._removeStream(stream);
            }
        }
    } else {
        this.localStreams.forEach(function (stream) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            //Half-working fix for Firefox, see: https://bugzilla.mozilla.org/show_bug.cgi?id=1208373
            if (shouldWorkAroundFirefoxStopStream()) {
                self._removeStream(stream);
            }
        });
    }
};


function getDisplayMedia() {
    // getDisplayMedia should only be called after checking we have a source available
    if (!isScreenShareSourceAvailable()) {
        // TODO throw an error or something
    }
    if (navigator.mediaDevices.getDisplayMedia) {
        return navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    } else if (navigator.getDisplayMedia) {
        // chrome 70+
        return navigator.getDisplayMedia({ video: true }).then(function(screenStream) {
            return navigator.mediaDevices.getUserMedia({ video: false, audio: true }).then(function(audioStream) {
                return new Promise(function(resolve, reject) {
                    try {
                        var screenWithAudio = new MediaStream();
                        screenWithAudio.addTrack(screenStream.getVideoTracks()[0]);
                        screenWithAudio.addTrack(audioStream.getAudioTracks()[0]);
                        resolve(screenWithAudio);
                    } catch (err) {
                        // TODO - is it worth trying without audio? probably not
                        reject(err);
                    }
                });
            });
        });
    } else {
        // firefox ? <= x <= 64
        return navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { mediaSource: 'screen' }
        });
    }

}

LocalMedia.prototype.startScreenShare = function (constraints, cb) {
    var self = this;

    this.emit('localScreenRequested');

    if (!isScreenShareSourceAvailable()) {
        self.emit('localScreenRequestFailed');
        return;
    }

    // in the case that no constraints are passed,
    // but a callback is, swap
    if (typeof constraints === 'function' && !cb) {
        cb = constraints;
        constraints = null;
    }

    getDisplayMedia().then(function (stream) {
        self.localScreens.push(stream);

        stream.getTracks().forEach(function (track) {
            track.addEventListener('ended', function () {
                var isAllTracksEnded = true;
                stream.getTracks().forEach(function (t) {
                    isAllTracksEnded = t.readyState === 'ended' && isAllTracksEnded;
                });

                if (isAllTracksEnded) {
                    self._removeStream(stream);
                }
            });
        });

        self.emit('localScreen', stream);
        if (cb) {
            cb(null, stream);
        }
    }).catch(function (err) {
        self.emit('localScreenRequestFailed');
        if (cb) {
            cb(err);
        }
    });
};

LocalMedia.prototype.stopScreenShare = function (stream) {
    var self = this;

    if (stream) {
        var idx = this.localScreens.indexOf(stream);
        if (idx > -1) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            this._removeStream(stream);
        }
    } else {
        this.localScreens.forEach(function (stream) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            self._removeStream(stream);
        });
    }
};

// Audio controls
LocalMedia.prototype.mute = function () {
    this._audioEnabled(false);
    this.emit('audioOff');
};

LocalMedia.prototype.unmute = function () {
    this._audioEnabled(true);
    this.emit('audioOn');
};

// Video controls
LocalMedia.prototype.pauseVideo = function () {
    this._videoEnabled(false);
    this.emit('videoOff');
};
LocalMedia.prototype.resumeVideo = function () {
    this._videoEnabled(true);
    this.emit('videoOn');
};

// Combined controls
LocalMedia.prototype.pause = function () {
    this.mute();
    this.pauseVideo();
};
LocalMedia.prototype.resume = function () {
    this.unmute();
    this.resumeVideo();
};

// Internal methods for enabling/disabling audio/video
LocalMedia.prototype._audioEnabled = function (bool) {
    this.localStreams.forEach(function (stream) {
        stream.getAudioTracks().forEach(function (track) {
            track.enabled = !!bool;
        });
    });
};
LocalMedia.prototype._videoEnabled = function (bool) {
    this.localStreams.forEach(function (stream) {
        stream.getVideoTracks().forEach(function (track) {
            track.enabled = !!bool;
        });
    });
};

// check if all audio streams are enabled
LocalMedia.prototype.isAudioEnabled = function () {
    var enabled = true;
    this.localStreams.forEach(function (stream) {
        stream.getAudioTracks().forEach(function (track) {
            enabled = enabled && track.enabled;
        });
    });
    return enabled;
};

// check if all video streams are enabled
LocalMedia.prototype.isVideoEnabled = function () {
    var enabled = true;
    this.localStreams.forEach(function (stream) {
        stream.getVideoTracks().forEach(function (track) {
            enabled = enabled && track.enabled;
        });
    });
    return enabled;
};

LocalMedia.prototype._removeStream = function (stream) {
    var idx = this.localStreams.indexOf(stream);
    if (idx > -1) {
        this.localStreams.splice(idx, 1);
        this.emit('localStreamStopped', stream);
    } else {
        idx = this.localScreens.indexOf(stream);
        if (idx > -1) {
            this.localScreens.splice(idx, 1);
            this.emit('localScreenStopped', stream);
        }
    }
};

LocalMedia.prototype._setupAudioMonitor = function (stream, harkOptions) {
    this._log('Setup audio');
    var audio = hark(stream, harkOptions);
    var self = this;
    var timeout;

    audio.on('speaking', function () {
        self.emit('speaking');
    });

    audio.on('stopped_speaking', function () {
        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(function () {
            self.emit('stoppedSpeaking');
        }, 1000);
    });
    audio.on('volume_change', function (volume, threshold) {
        self.emit('volumeChange', volume, threshold);
    });

    this._audioMonitors.push({audio: audio, stream: stream});
};

LocalMedia.prototype._stopAudioMonitor = function (stream) {
    var idx = -1;
    this._audioMonitors.forEach(function (monitors, i) {
        if (monitors.stream === stream) {
            idx = i;
        }
    });

    if (idx > -1) {
        this._audioMonitors[idx].audio.stop();
        this._audioMonitors.splice(idx, 1);
    }
};
module.exports = LocalMedia;
