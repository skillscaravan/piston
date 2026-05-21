FROM debian:buster-slim
ENV DEBIAN_FRONTEND noninteractive
# Debian buster reached EOL on 2024-06-30 and was moved to archive.debian.org.
# This redirect keeps apt working. TODO: migrate base image to debian:bookworm-slim.
RUN sed -i 's|http://deb.debian.org|http://archive.debian.org|g; s|http://security.debian.org/debian-security|http://archive.debian.org/debian-security|g' /etc/apt/sources.list && \
    sed -i '/buster-updates/d' /etc/apt/sources.list && \
    echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99no-check-valid-until
RUN apt-get update && apt-get install -y unzip autoconf build-essential libssl-dev \
        pkg-config zlib1g-dev libargon2-dev libsodium-dev libcurl4-openssl-dev \
        sqlite3 libsqlite3-dev libonig-dev libxml2 libxml2-dev bc curl git \
        "linux-headers-$(dpkg --print-architecture)" perl xz-utils python3 python3-pip gnupg jq zlib1g-dev \
        cmake cmake-doc extra-cmake-modules build-essential gcc binutils bash coreutils \
        util-linux pciutils usbutils coreutils binutils findutils grep libncurses5-dev \
        libncursesw5-dev python3-pip libgmp-dev libmpfr-dev python2 libffi-dev gfortran\
        libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev libfftw3-dev \
        libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev libsundials-dev \
        libbz2-dev liblzma-dev libpcre2-dev gperf bison flex g++ gawk zip && \
        ln -sf /bin/bash /bin/sh && \
        rm -rf /var/lib/apt/lists/* && \
        update-alternatives --install /usr/bin/python python /usr/bin/python3.7 2

ADD entrypoint.sh mkindex.sh serve.py /

ENTRYPOINT ["bash","/entrypoint.sh"]
CMD ["--no-build"]
