import Browserify from 'browserify';
import babelify from 'babelify';
import fs from 'fs';

let bundler = Browserify({ standalone: 'LocalMedia' })
bundler.add('./localmedia.js');
bundler
    .transform(babelify.configure({
        presets : ["@babel/preset-env"]
    }))
    .bundle((err, src) => {
        if(err) {
            console.log('[error]', err);
            return;
        }
        if(src) {
            console.log("Bundling Ok")
        }
    })
    .pipe(fs.createWriteStream('localMedia.bundle.js'));
