/* global process */
const gulp = require("gulp");
const sourcemaps = require("gulp-sourcemaps");
const tsb = require("gulp-tsb");
const del = require("del");
const exec = require("child_process").exec;
const path = require("path");
const lib = tsb.create("src/lib");
const clientRoot = process.env.GRAMMARKDOWN_CLIENT || "../grammarkdown-client";

gulp.task("clean:lib", () => del(["out/lib"]));
gulp.task("clean", ["clean:lib"]);

gulp.task("build:lib", () => lib
    .src()
    .pipe(sourcemaps.init())
    .pipe(lib.compile())
    .pipe(sourcemaps.write(".", { includeContent: false, destPath: "out/lib" }))
    .pipe(gulp.dest("out/lib")));

gulp.task("build", ["build:lib", "deploy:server"]);

gulp.task("watch", ["build"], () => gulp.watch(["src/**/*"], ["build"]));

gulp.task("default", ["build"]);

gulp.task("deploy:package.json", () => gulp
    .src("package.json")
    .pipe(gulp.dest(path.join(clientRoot, "server"))));

gulp.task("deploy:server", ["build:lib"], () => gulp
    .src(["out/**/*"])
    .pipe(gulp.dest(path.join(clientRoot, "server/out"))));

gulp.task("deploy:dependencies", ["deploy:package.json"], cb =>
    exec("npm update --production", { cwd: path.resolve(clientRoot, "server") }, err => err
        ? exec("npm install --production", { cwd: path.resolve(clientRoot, "server") }, cb)
        : cb()));

gulp.task("deploy", ["deploy:package.json", "deploy:dependencies", "deploy:server"]);